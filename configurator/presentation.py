"""Read-only projections for the administration shell; writes stay in Editor."""
from .editing import Editor


def overview(view):
    inventory = view.inventory()
    snapshot = Editor(view).snapshot()
    alarms = []
    for alarm in inventory['alarms']:
        aid = str(alarm['id'])
        pads = [dict(p['address'], name=p['name']) for p in inventory['keypads']
                if alarm['id'] in p['alarm_ids'] and p['address']]
        # Preserve explicit grants for keypads temporarily absent from discovery.
        known = {(p['source'], p['endpoint']) for p in pads}
        for grant in snapshot['grants'][aid].values():
            for pad in grant['keypads']:
                pair = (pad['source'], pad['endpoint'])
                if pair not in known:
                    pads.append(dict(pad, name='Previously allowed keypad (not discovered)'))
                    known.add(pair)
        alarms.append(dict(alarm, users=list(snapshot['grants'][aid].values()), keypads=pads))
    current = next(a for a in alarms if a['id'] == view.alarm_id)
    caps = snapshot['capabilities'][str(view.alarm_id)]
    hb = view.core.homebridge.status() if view.core.homebridge else None
    binding = next((b for b in (hb or {}).get('bindings', []) if b['gateway'] == view.gateway_id), None)
    return {'identities': list(snapshot['identities'].values()), 'alarms': alarms,
            'users': current['users'], 'keypads': current['keypads'], 'managed': current['managed'],
            'schedules': caps.get('schedules') is True and caps.get('schedule_version') == 1,
            'homebridge_sync': False, 'homebridge_available': hb is not None, 'homebridge_binding': binding,
            'transaction': view.core.transactions.status(view.gateway_id)}
