#!/usr/bin/env python3
"""Authenticated HTTPS frontend. This process has no gateway keys or sudo rights."""
import re
import html
import copy
import argparse
import hashlib
import hmac
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import ssl
import threading
import time
from urllib.parse import urlsplit

from .common import LIMIT, Rejected, loads, require, rpc

class Security:
    def __init__(self, config, account_store=None):
        self.config = config
        self.account_store = account_store
        self.version = None
        self.verifier = config
        self.sessions = {}
        self.attempts = []
        self.lock = threading.Lock()

    def refresh(self):
        if self.account_store is None: return
        from .web_account import validate
        record = self.account_store('web_auth_read', {})
        if record is not None: validate(record)
        version = record['revision'] if record else None
        if version != self.version:
            # Preserve sessions only when their complete named account is unchanged.
            # Never carry a legacy login across migration or an uncertain write.
            old = {r['id']: r for r in self.verifier.get('accounts', [])}
            new = {r['id']: r for r in (record or {}).get('accounts', [])}
            self.sessions = {token: dict(session, revision=version)
                             for token, session in self.sessions.items()
                             if session['account_id'] in old and
                             old[session['account_id']] == new.get(session['account_id']) and
                             new[session['account_id']]['enabled']}
        self.version = version
        self.verifier = record or self.config

    def verify(self, password, verifier=None):
        verifier = verifier or self.verifier
        require(isinstance(password, str) and len(password) <= 256, 'login_failed')
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(verifier['salt']), n=16384, r=8, p=1).hex()
        require(hmac.compare_digest(digest, verifier['password_hash']), 'login_failed')

    def limit(self):
        now = time.monotonic()
        self.attempts = [x for x in self.attempts if now - x < 60]
        require(len(self.attempts) < 6, 'login_rate_limited')
        self.attempts.append(now)

    def change_password(self, token, body):
        require(set(body) == {'current_password', 'new_password', 'repeat_password'}, 'body_rejected')
        with self.lock:
            self.refresh()
            session = self.sessions.get(token); now = time.monotonic()
            require(session and now < session['expires'] and now < session['idle'], 'login_required')
            require(self.account_store is not None, 'web_account_unavailable')
            self.limit()
            try: self.verify(body['current_password'], self.account(session))
            except Rejected: raise Rejected('current_password_incorrect') from None
            password = body['new_password']
            require(isinstance(password, str) and 8 <= len(password) <= 256, 'password_length_invalid')
            require(password == body['repeat_password'], 'passwords_do_not_match')
            require(password != body['current_password'], 'password_unchanged')
            salt = secrets.token_hex(16)
            digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
            try:
                if self.verifier.get('schema') == 2:
                    rows = copy.deepcopy(self.verifier['accounts'])
                    row = next(r for r in rows if r['id'] == session['account_id'])
                    row.update(salt=salt,password_hash=digest)
                    self.account_store('web_auth_change', {'expected_revision':self.version,'accounts':rows})
                else:
                    self.account_store('web_auth_change', {'expected_revision': self.version, 'salt': salt, 'password_hash': digest})
            except Exception:
                self.sessions.clear()
                raise
            self.refresh()
            return {'changed': True, 'sign_in_required': True}

    def login(self, password, username=None):
        with self.lock:
            now = time.monotonic()
            self.refresh(); self.limit()
            account = self.verifier
            if self.verifier.get('schema') == 2:
                account = next((r for r in self.verifier['accounts'] if isinstance(username,str) and
                                r['username'].casefold() == username.casefold()), None)
                # Unknown names still incur the password KDF; do not disclose account existence.
                self.verify(password, account or self.verifier['accounts'][0])
                require(account is not None and account['enabled'], 'login_failed')
            else:
                expected = self.config.get('username')
                require((username is None or username == '') if expected is None else
                        isinstance(username,str) and username.casefold() == expected.casefold(), 'login_failed')
                self.verify(password)

            self.sessions = {k: v for k, v in self.sessions.items() if now < v['expires'] and now < v['idle']}
            require(len(self.sessions) < 12, 'session_limit')
            token = secrets.token_urlsafe(32)
            self.sessions[token] = {'csrf': secrets.token_urlsafe(32), 'expires': now + 8*3600, 'idle': now + 1800, 'account_id':account.get('id'), 'role':account.get('role','admin'), 'username':account.get('username',self.config.get('username')), 'revision':self.version}
            return token

    def session(self, token):
        with self.lock:
            self.refresh()
            session = self.sessions.get(token)
            now = time.monotonic()
            require(session and now < session['expires'] and now < session['idle'], 'login_required')
            session['idle'] = now + 1800
            return dict(session)

    def account(self, session):
        if self.verifier.get('schema') != 2: return self.verifier
        row = next((r for r in self.verifier['accounts'] if r['id'] == session['account_id']), None)
        require(row and row['enabled'], 'login_required')
        return row

    def public(self, session):
        return {k:session[k] for k in ('csrf','account_id','username','role')} | {'username_required':not bool(session['username'])}

    def accounts(self, token):
        session = self.session(token)
        with self.lock:
            self.refresh()
            require(token in self.sessions, 'login_required')
            result = {'revision':self.version, 'account':self.public(session)}
            if session['role'] == 'admin':
                result['accounts'] = [{k:r[k] for k in ('id','username','role','enabled')}
                                      for r in self.verifier.get('accounts',[])]
            return result

    def manage_account(self, token, body):
        session = self.session(token)
        with self.lock:
            self.refresh()
            require(token in self.sessions, 'login_required')
            require(session['role'] == 'admin', 'forbidden')
            require(self.account_store is not None, 'web_account_unavailable')
            action = body.get('action')
            fields = {'action','expected_revision','current_password'}
            shapes = {'claim':fields|{'username'}, 'save':fields|{'id','username','role','enabled','password','repeat_password'},
                      'delete':fields|{'id'}}
            require(isinstance(action,str) and action in shapes and set(body) == shapes[action], 'body_rejected')
            require(body['expected_revision'] == self.version and type(body['expected_revision']) is type(self.version), 'web_account_changed')
            self.limit()
            try:self.verify(body['current_password'],self.account(session))
            except Rejected:raise Rejected('current_password_incorrect') from None
            from .web_account import username, validate
            rows = copy.deepcopy(self.verifier.get('accounts',[]))
            if action == 'claim':
                require(not rows, 'username_already_configured')
                rows = [{'id':secrets.token_hex(16),'username':username(body['username']),'role':'admin','enabled':True,
                         'salt':self.verifier['salt'],'password_hash':self.verifier['password_hash']}]
            else:
                require(rows, 'admin_username_required')
                require(body['id'] is None or isinstance(body['id'],str), 'body_rejected')
                row = next((r for r in rows if r['id'] == body['id']), None)
                require(body['id'] is None or row is not None, 'account_not_found')
                if action == 'delete':
                    require(row is not None, 'account_not_found');rows.remove(row)
                else:
                    username(body['username'])
                    require(body['role'] in ('admin','regular') and type(body['enabled']) is bool, 'body_rejected')
                    require(isinstance(body['password'],str) and body['password'] == body['repeat_password'], 'passwords_do_not_match')
                    if row is None:
                        row = {'id':secrets.token_hex(16)};rows.append(row)
                    if body['password'] or 'salt' not in row:
                        require(8 <= len(body['password']) <= 256, 'password_length_invalid')
                        salt = secrets.token_hex(16)
                        row.update(salt=salt,password_hash=hashlib.scrypt(body['password'].encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex())
                    row.update(username=body['username'],role=body['role'],enabled=body['enabled'])
            require(any(r['role']=='admin' and r['enabled'] for r in rows), 'last_admin_required')
            validate({'schema':2,'revision':(self.version or 0)+1,'accounts':rows})
            try:self.account_store('web_auth_change',{'expected_revision':self.version,'accounts':rows})
            except Exception:
                self.sessions.clear()
                raise
            self.refresh()
            return {'changed':True,'sign_in_required':token not in self.sessions}


ROUTES = {
    ('POST', '/api/setup/finish'): 'setup_finish',
    ('GET', '/api/debug'): 'debug_status', ('POST', '/api/debug/control'): 'debug_control',
    ('GET', '/api/administration'): 'administration',
    ('GET', '/api/activity-options'): 'activity_options',
    ('POST', '/api/history/query'): 'history_query',
    ('POST', '/api/history/clear'): 'history_clear',
    ('POST', '/api/history/retention'): 'history_retention',
    ('POST', '/api/setup/probe'): 'setup_probe',
    ('POST', '/api/setup/connect'): 'setup_connect',
    ('GET', '/api/setup/local-gateways'): 'setup_local_gateways',
    ('POST', '/api/recovery/credential'): 'verify_credential',
    ('POST', '/api/setup/gateway'): 'setup_gateway', ('POST', '/api/setup/application'): 'setup_application',
    ('GET', '/api/editor'): 'editor', ('POST', '/api/discover'): 'discover',
    ('GET', '/api/setup'): 'setup', ('GET', '/api/gateways'): 'gateways',
    ('GET', '/api/inventory'): 'inventory', ('GET', '/api/overview'): 'overview',
    ('GET', '/api/alarm'): 'alarm', ('GET', '/api/lockout'): 'lockout',
    ('GET', '/api/history'): 'history',
    ('POST', '/api/users/save'): 'save_user', ('POST', '/api/users/delete'): 'delete_user',
    ('POST', '/api/users/rotate-pin'): 'rotate_pin', ('POST', '/api/alarm/save'): 'save_alarm',
    ('POST', '/api/lockout/save'): 'save_lockout', ('POST', '/api/lockout/reset'): 'reset_lockout',
    ('GET', '/api/keypad'): 'keypad_status', ('POST', '/api/keypad/send'): 'keypad_send',
    ('GET', '/api/transaction'): 'transaction_status',
    ('POST', '/api/recovery/review'): 'review_recovery', ('POST', '/api/recovery/confirm'): 'recover_transaction',
}

ASSETS = {'/app-icon.svg': ('app-icon.svg', 'image/svg+xml'), '/apple-touch-icon.png': ('apple-touch-icon.png', 'image/png'), '/app-icon-192.png': ('app-icon-192.png', 'image/png'), '/app-icon-512.png': ('app-icon-512.png', 'image/png'), '/manifest.webmanifest': ('manifest.webmanifest', 'application/manifest+json'), '/settings.js': ('settings.js', 'text/javascript'), '/welcome.html': ('welcome.html', 'text/html'), '/welcome.js': ('welcome.js', 'text/javascript'),
          '/welcome.css': ('welcome.css', 'text/css'), '/installation-help.html': ('installation-help.html', 'text/html'),'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'),
          '/style.css': ('style.css', 'text/css'), '/homebridge-flow.js': ('homebridge-flow.js', 'text/javascript'),
          '/keypad.js': ('keypad.js', 'text/javascript'), '/demo.js': ('demo.js', 'text/javascript'),
          '/setup.html': ('setup.html', 'text/html'), '/setup-app.js': ('setup-app.js', 'text/javascript'),
          '/setup-style.css': ('setup-style.css', 'text/css')}

def handler(config, security, assets):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'Configurator'
        sys_version = ''
        def log_message(self, *_):
            pass  # URLs, headers, bodies and raw exceptions are never logged.
        def setup(self):
            super().setup()
            self.connection.settimeout(10)
        def respond(self, status, value, kind='application/json', cookie=None, embeddable=False):
            raw = json.dumps(value, allow_nan=False).encode() if kind == 'application/json' else value
            self.send_response(status)
            self.send_header('Content-Type', kind + '; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            ancestors="'self'" if embeddable else "'none'"
            self.send_header('Content-Security-Policy', f"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; frame-src 'self'; frame-ancestors {ancestors}; form-action 'self'")
            self.send_header('X-Frame-Options', 'SAMEORIGIN' if embeddable else 'DENY')
            self.send_header('Connection', 'close')
            if cookie:
                self.send_header('Set-Cookie', cookie)
            self.end_headers()
            self.wfile.write(raw)
        def token(self):
            jar = cookies.SimpleCookie()
            jar.load(self.headers.get('Cookie', ''))
            return jar['__Host-configurator'].value if '__Host-configurator' in jar else ''
        def dispatch(self):
            try:
                require(self.headers.get_all('Host') == [urlsplit(config['origin']).netloc], 'host_rejected')
                require('?' not in self.path and '#' not in self.path, 'query_not_allowed')
                require(len(self.headers.get_all('Origin', [])) <= 1, 'origin_rejected')
                origin = self.headers.get('Origin')
                require(origin is None or origin == config['origin'], 'origin_rejected')
                require(self.headers.get('Sec-Fetch-Site', 'same-origin') in ('same-origin', 'none'), 'origin_rejected')
                body = {}
                if self.command == 'POST':
                    require(origin == config['origin'], 'origin_required')
                    require(not self.headers.get('Transfer-Encoding'), 'body_rejected')
                    lengths = self.headers.get_all('Content-Length') or []
                    require(len(lengths) == 1 and lengths[0].isdigit(), 'body_rejected')
                    length = int(lengths[0])
                    require(0 < length <= LIMIT, 'body_rejected')
                    require(self.headers.get('Content-Type', '').split(';')[0] == 'application/json', 'body_rejected')
                    body = loads(self.rfile.read(length))
                    require(isinstance(body, dict), 'body_rejected')
                if self.command == 'GET' and self.path in ASSETS:
                    filename, kind = ASSETS[self.path]
                    raw=(assets / filename).read_bytes()
                    if filename in ('index.html','welcome.html','setup.html','manifest.webmanifest'):
                        from .setup import home_screen_name, DEFAULTS
                        name=DEFAULTS['home_screen_name']
                        try:name=home_screen_name(rpc(config['socket'],'public_branding',{})['home_screen_name'])
                        except Exception:pass  # Keep the login page available if the broker is unavailable.
                        if filename=='manifest.webmanifest':
                            value=loads(raw);value.update(name=name,short_name=name)
                            raw=json.dumps(value,ensure_ascii=False).encode()
                        else:
                            raw=raw.decode().replace('name="apple-mobile-web-app-title" content="Keypad Cntrl"',
                                'name="apple-mobile-web-app-title" content="'+html.escape(name,quote=True)+'"').encode()
                    return self.respond(200, raw, kind)
                if self.command == 'POST' and self.path == '/api/login':
                    require(set(body) in ({'password'},{'username','password'}), 'body_rejected')
                    token = security.login(body['password'],body.get('username'))
                    return self.respond(200, security.public(security.session(token)), cookie='__Host-configurator=' + token + '; Secure; HttpOnly; SameSite=Strict; Path=/')
                session = security.session(self.token())
                if self.command == 'POST':
                    require(hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), session['csrf']), 'csrf_rejected')
                if self.command == 'GET' and self.path == '/api/session':
                    return self.respond(200, security.public(session))
                if self.command == 'POST' and self.path == '/api/logout':
                    with security.lock:
                        security.sessions.pop(self.token(), None)
                    return self.respond(200, {}, cookie='__Host-configurator=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/')
                if self.command == 'POST' and self.path == '/api/account/password':
                    result = security.change_password(self.token(), body)
                    return self.respond(200, result, cookie='__Host-configurator=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/')
                if self.path == '/api/accounts':
                    if self.command == 'GET':return self.respond(200,security.accounts(self.token()))
                    result=security.manage_account(self.token(),body)
                    return self.respond(200,result,cookie=('__Host-configurator=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/' if result['sign_in_required'] else None))
                def authorized(operation, body):
                    try:
                        return rpc(config['socket'],'authenticated_request',{'account_id':session['account_id'],
                            'revision':session['revision'],'operation':operation,'body':body})
                    except Rejected as error:
                        if str(error) == 'login_required':
                            # An unrelated account save may race this request's snapshot.
                            # Keep the broker denial and never replay a request, but do not
                            # falsely sign out an account whose session is still valid.
                            latest = security.session(self.token())
                            if latest['revision'] != session['revision']:
                                raise Rejected('account_revision_changed') from None
                        raise
                if self.command == 'GET' and self.path == '/api/settings':
                    result = authorized('installation_settings', {})
                    result['web'] = {'port': config['port'], 'origin': config['origin'], 'bind': config['bind']}
                    return self.respond(200, result)
                extension = re.fullmatch(r'/(api/extensions|extensions)/([a-z][a-z0-9-]{0,26})/([a-z][a-z0-9.-]{0,31})', self.path)
                if extension:
                    asset=extension[1]=='extensions'
                    require(not self.headers.get('X-Configurator-Gateway') and not self.headers.get('X-Configurator-Alarm'),'extension_request_invalid')
                    result=authorized('extension_request',{'id':extension[2],'route':extension[3],
                        'method':self.command,'body':body,'asset':asset})
                    if asset:return self.respond(200,result['content'].encode(),result['mime'],embeddable=result['mime']=='text/html')
                    return self.respond(200,result)
                operation = ROUTES.get((self.command, self.path))
                require(operation is not None, 'route_not_found')
                gateway=self.headers.get('X-Configurator-Gateway')
                alarm=self.headers.get('X-Configurator-Alarm')
                require(len(self.headers.get_all('X-Configurator-Gateway',[]))<=1 and len(self.headers.get_all('X-Configurator-Alarm',[]))<=1, 'invalid_gateway_request')
                require(alarm is None or gateway is not None, 'invalid_gateway_request')
                if gateway is not None and operation not in ('gateways', 'setup', 'setup_gateway', 'setup_application', 'setup_local_gateways', 'setup_probe', 'setup_connect', 'activity_options', 'history_query', 'history_clear', 'history_retention'):
                    require(re.fullmatch('[a-z][a-z0-9-]{0,31}',gateway) is not None,'invalid_gateway_request')
                    require(alarm is None or re.fullmatch('[0-9]{1,3}',alarm) is not None,'invalid_alarm')
                    body={'gateway':gateway,'alarm':int(alarm) if alarm else None,'operation':operation,'body':body}
                    operation='gateway_request'
                result = authorized(operation, body)
                return self.respond(200, result)
            except Rejected as error:
                reason = str(error)
                status = 401 if reason in ('login_required', 'login_failed') else 403 if reason == 'forbidden' else 400
                self.respond(status, {'error': reason})
            except Exception:
                self.respond(503, {'error': 'service_unavailable_private_details_omitted'})
        do_GET = dispatch
        do_POST = dispatch
    return Handler

class Server(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, *args):
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(*args)
    def get_request(self):
        raw, address = self.socket.accept()
        raw.settimeout(5)
        try:
            return self.tls.wrap_socket(raw, server_side=True), address
        except Exception:
            raw.close()
            raise
    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise
    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()
    def handle_error(self, *_):
        pass

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    require(args.config.is_absolute() and args.config.resolve() == args.config and args.config.is_file(), 'web_configuration_invalid')
    require(args.config.stat().st_mode & 0o077 == 0 and args.config.stat().st_size <= LIMIT, 'private_configuration_required')
    config = loads(args.config.read_bytes())
    require(isinstance(config, dict) and set(config) in ({'bind','port','origin','socket','cert','key','salt','password_hash'}, {'bind','port','origin','socket','cert','key','salt','password_hash','username'}), 'web_configuration_invalid')
    require(urlsplit(config['origin']).scheme == 'https' and urlsplit(config['origin']).path == '' and not urlsplit(config['origin']).query and not urlsplit(config['origin']).fragment and not urlsplit(config['origin']).username, 'web_origin_invalid')
    require(type(config['port']) is int and 1024 <= config['port'] <= 65535, 'web_port_invalid')
    server = Server((config['bind'], config['port']), handler(config, Security(config, lambda op, body: rpc(config['socket'], op, body)), Path(__file__).parent / 'static'))
    server.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.tls.minimum_version = ssl.TLSVersion.TLSv1_2
    server.tls.load_cert_chain(config['cert'], config['key'])
    server.serve_forever()

if __name__ == '__main__':
    main()
