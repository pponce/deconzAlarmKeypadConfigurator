"""Bounded REST transport with identity and capability checks; no command probes."""
import json
import re
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from .common import loads, require, Rejected
from .domain import SAFE_GATEWAY_ERRORS


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


class GatewayRejected(Rejected):
    def __init__(self, reason, definite=False):
        super().__init__(reason)
        self.definite = definite


class Gateway:
    def __init__(self, registration, writable=False):
        self.writable = writable
        self.registration=registration
        self.origin=registration['endpoint'].rstrip('/')
        self.key=registration['key']

    def exchange(self, path, method='GET', body=None):
        if method != 'GET':
            require(self.writable, 'candidate_read_only_required')
            require(method in ('POST','PUT','DELETE') and isinstance(body,dict) and re.fullmatch(
                r'/alarmsystems/(?:users/[0-9a-f]{32}|[1-9][0-9]{0,2}/(?:users(?:/(?:[0-9a-f]{32}|lockout))?|config|disarm|arm_stay|arm_night|arm_away))', path), 'gateway_route_invalid')
            collection = path.endswith('/users')
            grant_or_lockout = re.fullmatch(r'/alarmsystems/[1-9][0-9]{0,2}/users/(?:[0-9a-f]{32}|lockout)', path) is not None
            require(method == 'POST' if collection else method in ('PUT','DELETE') if grant_or_lockout else method == 'PUT', 'gateway_route_invalid')
        else: require(body is None, 'gateway_route_invalid')
        require(path.startswith('/') and '?' not in path and '#' not in path and '..' not in path,
                'gateway_route_invalid')
        request=Request(self.origin+'/api/'+self.key+path,method=method,
                        headers={'Content-Type':'application/json'},
                        data=None if body is None else json.dumps(body,allow_nan=False).encode())
        try:
            with build_opener(ProxyHandler({}),NoRedirect()).open(request,timeout=8) as reply:
                status=reply.status;raw=reply.read(4*1024*1024+1)
        except HTTPError as error:
            status=error.code;raw=error.read(4*1024*1024+1)
        except Exception:raise Rejected('gateway_result_unknown_no_retry') from None
        require(len(raw)<=4*1024*1024,'gateway_response_invalid')
        try:return status,loads(raw)
        except Exception:raise Rejected('gateway_response_invalid') from None

    def request(self,path,method='GET',body=None):
        status,value=self.exchange(path,method,body)
        if isinstance(value,list):
            reason=next((r.get('error',{}).get('description') for r in value if isinstance(r,dict)),None)
            if reason in SAFE_GATEWAY_ERRORS:
                # Only exact finite validation errors prove non-application. Storage
                # failures, mixed responses and unrelated addresses remain uncertain.
                match=re.fullmatch(r'/alarmsystems/([1-9][0-9]{0,2})/users(?:/.*)?',path)
                address='/alarmsystems/'+(match.group(1) if match else '0')+'/users'
                definite=(method!='GET' and status in (200,400) and len(value)==1 and set(value[0])=={'error'} and
                    value[0]['error'].get('type')==7 and value[0]['error'].get('address')==address and
                    reason not in {'storage_error','update_failed_or_revision_conflict','delete_failed_or_revision_conflict'})
                raise GatewayRejected(reason, definite)
            if status==200 and value and all(isinstance(r,dict) and set(r)=={'success'} for r in value):return value
            raise Rejected('gateway_result_unknown_no_retry')
        require(status==200 and isinstance(value,dict),'gateway_response_invalid')
        return value

    def verify(self, alarm=None):
        config=self.request('/config')
        identity=str(config.get('bridgeid','')).replace(':','').upper()
        require(identity==self.registration['identity'],'gateway_identity_changed')
        if alarm is not None:
            caps=self.request('/alarmsystems/'+str(alarm)+'/users/capabilities')
            require(caps.get('global_users_version')==2,'enhanced_plugin_required')
            return caps
        return config
