"""Finite first-release deployment choices; no remote service-control transport."""
import ipaddress
import socket
from urllib.parse import urlsplit
from .common import require

MODES = {
    'local-core': 'Local deCONZ without Homebridge',
    'local-homebridge': 'Local deCONZ with local Homebridge child bridge',
    'remote-core': 'Remote deCONZ without Homebridge',
}
REMOTE_BACKUP_NOTICE = ('Only policy snapshots are saved here. Back up the deCONZ database on its own host. '
    'If a credential write becomes uncertain, this installation cannot verify the remote database; '
    'the operation remains held for administrator-assisted recovery. Do not retry the write or delete its journal.')


def local_endpoint(endpoint):
    """Require an explicit local IP (or localhost), without a DNS locality guess."""
    host = urlsplit(endpoint).hostname
    if host == 'localhost': return True
    try: address = ipaddress.ip_address(host)
    except ValueError: return False
    if address.is_unspecified or address.is_multicast: return False
    if address.is_loopback: return True
    try:
        with socket.socket(socket.AF_INET6 if address.version == 6 else socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind((str(address), 0))
        return True
    except OSError: return False


def validate(mode, gateways, homebridge, databases, backup_acknowledged):
    require(mode in MODES and len(gateways) == 1, 'deployment_choice_invalid')
    if mode != 'remote-core':
        require(local_endpoint(gateways[0]['endpoint']), 'local_gateway_address_required')
    if mode == 'local-homebridge':
        require(homebridge is not None and len(databases) == 1, 'local_homebridge_setup_required')
    else:
        require(homebridge is None and databases == [], 'standalone_integration_not_allowed')
    require(backup_acknowledged is True, 'backup_plan_confirmation_required')
    return {'schema': 1, 'mode': mode, 'gateway_identity': gateways[0]['identity'],
            'gateway_id': gateways[0]['id'], 'backup_acknowledged': True}


def public(value):
    require(isinstance(value, dict) and set(value) == {'schema', 'mode', 'gateway_identity', 'gateway_id', 'backup_acknowledged'}
            and value['schema'] == 1 and value['mode'] in MODES and value['backup_acknowledged'] is True,
            'deployment_record_invalid')
    return {'mode': value['mode'], 'label': MODES[value['mode']],
            'credential_backup': 'local-database' if value['mode'] == 'local-homebridge' else 'administrator-managed',
            'remote_credential_recovery': False}


def check_events(gateway, config):
    """Bounded WebSocket handshake only; no event data or device commands."""
    import base64
    import hashlib
    import http.client
    import secrets
    from .common import Rejected
    port = config.get('websocketport')
    require(type(port) is int and 1 <= port <= 65535, 'websocket_port_missing')
    endpoint = urlsplit(gateway['endpoint'])
    cls = http.client.HTTPSConnection if endpoint.scheme == 'https' else http.client.HTTPConnection
    connection = cls(endpoint.hostname, port, timeout=4)
    key = base64.b64encode(secrets.token_bytes(16)).decode()
    try:
        connection.request('GET', '/', headers={'Upgrade': 'websocket', 'Connection': 'Upgrade',
            'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13'})
        response = connection.getresponse()
        expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        require(response.status == 101 and response.getheader('Upgrade', '').lower() == 'websocket'
                and response.getheader('Sec-WebSocket-Accept') == expected, 'gateway_events_unavailable')
    except Exception:
        raise Rejected('gateway_events_unavailable') from None
    finally: connection.close()
