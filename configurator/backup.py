"""Explicit policy-export backup port; never claims to copy gateway credentials."""
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import stat
import tempfile
import time
from .common import atomic, require
from .configuration import directory


RETENTION_LIMIT = 20
_KINDS = {'gateway-policy': ('configurator-policy-', 'policy.json'),
          'local-sqlite': ('configurator-database-', 'gateway.sqlite')}


def _private_file(folder, name, limit=None):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
                info.st_nlink == 1 and not info.st_mode & 0o077 and
                (limit is None or info.st_size <= limit), 'backup_retention_file_changed')
        return fd, info
    except BaseException:
        os.close(fd)
        raise


def _metadata(folder, name, limit):
    fd, info = _private_file(folder, name, limit)
    with os.fdopen(fd, 'rb') as stream:
        raw = stream.read(limit + 1)
    require(len(raw) <= limit, 'backup_retention_metadata_too_large')
    value = json.loads(raw)
    require(isinstance(value, dict), 'backup_retention_metadata_invalid')
    return value, info


def _snapshot(root_fd, name, kind, identity):
    prefix, payload = _KINDS[kind]
    require(re.fullmatch(re.escape(prefix) + r'[A-Za-z0-9_-]+', name),
            'backup_retention_name_invalid')
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        info = os.fstat(fd)
        require(info.st_uid == os.geteuid() and not info.st_mode & 0o077,
                'backup_retention_directory_changed')
        names = {'receipt.json', 'policy.json', payload}
        # An extra file, including an explicit .keep marker, excludes the folder.
        require(set(os.listdir(fd)) == names, 'backup_retention_contents_changed')
        receipt, receipt_info = _metadata(fd, 'receipt.json', 65536)
        policy, _ = _metadata(fd, 'policy.json', 16 * 1024 * 1024)
        require(receipt.get('schema') == 1 and receipt.get('kind') == kind and
                receipt.get('snapshot') == name and receipt.get('automatic_restore') is False and
                receipt.get('credential_backup') is (kind == 'local-sqlite') and
                isinstance(receipt.get('sha256'), str) and
                re.fullmatch('[0-9a-f]{64}', receipt['sha256']) and
                policy.get('schema') == 1 and policy.get('gateway_identity') == identity and
                isinstance(policy.get('policy'), dict), 'backup_retention_scope_changed')
        created = receipt.get('created_ns', receipt_info.st_mtime_ns)
        require(type(created) is int and created > 0, 'backup_retention_date_invalid')
        payload_fd, _ = _private_file(fd, payload)
        os.close(payload_fd)
        return {'name': name, 'created': created, 'inode': (info.st_dev, info.st_ino),
                'receipt': receipt, 'files': names, 'payload': payload}
    finally:
        os.close(fd)


def _remove_snapshot(root_fd, item, kind, identity):
    current = _snapshot(root_fd, item['name'], kind, identity)
    require(current == item, 'backup_retention_snapshot_changed')
    fd = os.open(item['name'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    try:
        info = os.fstat(fd)
        require((info.st_dev, info.st_ino) == item['inode'], 'backup_retention_snapshot_changed')
        payload_fd, _ = _private_file(fd, item['payload'])
        with os.fdopen(payload_fd, 'rb') as stream:
            checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        require(checksum == item['receipt']['sha256'], 'backup_retention_checksum_changed')
        require(set(os.listdir(fd)) == item['files'], 'backup_retention_contents_changed')
        # Delete only the enumerated snapshot payloads. Never recursively delete
        # a configured root, migration directory or an unexpected extra file.
        for name in sorted(item['files'] - {'receipt.json'}):
            os.unlink(name, dir_fd=fd)
        os.unlink('receipt.json', dir_fd=fd)
        os.fsync(fd)
        again = os.stat(item['name'], dir_fd=root_fd, follow_symlinks=False)
        require((again.st_dev, again.st_ino) == item['inode'], 'backup_retention_snapshot_changed')
        os.rmdir(item['name'], dir_fd=root_fd)
        os.fsync(root_fd)
    finally:
        os.close(fd)


def retain(root, context, latest):
    """Bound successful snapshots in this root, gateway identity and backup kind.

    Normal callers serialize gateway edits and block further edits while a prior
    transaction is unfinished. The newly created pre-write backup is always kept,
    including when the subsequent gateway write fails. Unknown/partial folders,
    explicit .keep markers and migration backups elsewhere are never removed.
    Cleanup failure does not turn a successful backup into a failed gateway edit.
    """
    root = directory(str(root))
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    removed = 0
    try:
        lock = os.open('.retention.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=fd)
        lock_info = os.fstat(lock)
        require(stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid == os.geteuid() and
                lock_info.st_nlink == 1 and not lock_info.st_mode & 0o077,
                'backup_retention_lock_changed')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        kind = latest['kind']; identity = context['identity']
        latest_item = _snapshot(fd, latest['snapshot'], kind, identity)
        require(latest_item['receipt'] == latest, 'backup_retention_latest_changed')
        items = []
        for name in sorted(os.listdir(fd)):
            if name == latest['snapshot'] or not name.startswith(_KINDS[kind][0]):
                continue
            try:
                items.append(_snapshot(fd, name, kind, identity))
            except Exception:
                continue
        items.sort(key=lambda item: (item['created'], item['name']), reverse=True)
        # Reserve one of the twenty slots for this operation's backup even if
        # the wall clock moved backwards or legacy file timestamps are unusual.
        for item in items[RETENTION_LIMIT - 1:]:
            try:
                _remove_snapshot(fd, item, kind, identity)
                removed += 1
            except Exception:
                logging.getLogger(__name__).warning('Automatic backup cleanup incomplete; snapshot retained or partially retired.')
        return removed
    finally:
        if lock is not None:
            os.close(lock)
        os.close(fd)


def _retained(root, context, receipt):
    try:
        retain(root, context, receipt)
    except Exception:
        logging.getLogger(__name__).warning('Automatic backup cleanup deferred; new backup remains available.')
    return receipt


class PolicyBackup:
    api_version = 1
    credential_backup = False

    def __init__(self, root):
        self.root = directory(root)

    def save(self, context, snapshot):
        directory(str(self.root))
        destination = Path(tempfile.mkdtemp(prefix='configurator-policy-', dir=self.root))
        data = {'schema': 1, 'gateway_identity': context['identity'], 'policy': snapshot}
        atomic(destination / 'policy.json', data)
        digest = hashlib.sha256((destination / 'policy.json').read_bytes()).hexdigest()
        receipt = {'schema': 1, 'kind': 'gateway-policy', 'credential_backup': False,
                   'snapshot': destination.name, 'sha256': digest,
                   'automatic_restore': False, 'created_ns': time.time_ns()}
        atomic(destination / 'receipt.json', receipt)
        return _retained(self.root, context, receipt)


def profiles(value, gateways):
    """Database paths come only from protected host configuration, never the browser."""
    require(isinstance(value,list) and len(value)<=16,'database_backup_profile_invalid')
    seen=set();registered={r['id']:r['identity'] for r in gateways}
    for row in value:
        require(isinstance(row,dict) and set(row)=={'gateway','identity','path'},'database_backup_profile_invalid')
        require(row['gateway'] in registered and row['gateway'] not in seen and
                row['identity']==registered[row['gateway']],'database_backup_profile_invalid')
        path=Path(row['path']);require(path.is_absolute() and path.resolve()==path,'database_backup_path_invalid')
        seen.add(row['gateway'])
    return value


class Backups:
    api_version=1
    def __init__(self,root,registrations,configured):
        self.policy=PolicyBackup(root)
        self.profiles={row['gateway']:row for row in profiles(configured,registrations)}
        self.gateways=[row['id'] for row in registrations]

    def status(self):
        return [{'gateway':key,'kind':'local-sqlite' if key in self.profiles else 'gateway-policy',
                 'credential_backup':key in self.profiles,'automatic_restore':False,
                 'verified':False,'retention_limit':RETENTION_LIMIT} for key in self.gateways]

    def save(self,context,snapshot):
        import os
        import sqlite3
        import time
        profile=self.profiles.get(context['gateway'])
        if profile is None:return self.policy.save(context,snapshot)
        require(profile['identity']==context['identity'],'database_backup_identity_changed')
        path=Path(profile['path'])
        def identity():
            require(path.resolve()==path and path.is_file() and not path.is_symlink(),'database_backup_path_invalid')
            stat=path.stat()
            require(stat.st_mode & 0o022==0,'database_backup_permissions_invalid')
            for parent in path.parents:
                mode=parent.stat().st_mode
                require(mode & 0o022==0 or parent.stat().st_uid==0 and mode & 0o1000,'database_backup_permissions_invalid')
            return stat.st_dev,stat.st_ino
        before=identity()
        directory(str(self.policy.root))
        destination=Path(tempfile.mkdtemp(prefix='configurator-database-',dir=self.policy.root))
        target=destination/'gateway.sqlite'
        fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
        deadline=time.monotonic()+15
        def progress(*_):require(time.monotonic()<deadline,'database_backup_timeout')
        source=None;output=None
        try:
            source=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=2)
            source.execute('PRAGMA query_only=ON')
            require(identity()==before,'database_backup_source_changed')
            output=sqlite3.connect(target)
            source.backup(output,pages=128,progress=progress,sleep=0.05)
            require(identity()==before,'database_backup_source_changed')
            require(output.execute('PRAGMA quick_check').fetchall()==[('ok',)],'database_backup_integrity_failed')
            users=output.execute('SELECT uid,revision,hash FROM gateway_users_v2').fetchall()
            grants=output.execute('SELECT alarm,uid,revision FROM alarm_user_grants_v2').fetchall()
            expected={uid:row['user_revision'] for uid,row in snapshot['identities'].items()}
            require(len(users)==len(expected) and {uid:rev for uid,rev,_ in users}==expected and
                    all(isinstance(value,str) and bool(value) for _,_,value in users),'database_backup_policy_mismatch')
            expected_grants={(int(aid),uid):row['revision'] for aid,rows in snapshot['grants'].items() for uid,row in rows.items()}
            require(len(grants)==len(expected_grants) and {(aid,uid):rev for aid,uid,rev in grants}==expected_grants,
                    'database_backup_policy_mismatch')
            # An empty DB cannot establish association with an unenrolled gateway.
            require(bool(users),'database_backup_identity_unproven')
        finally:
            if output is not None:output.close()
            if source is not None:source.close()
        with target.open('rb') as stream:os.fsync(stream.fileno())
        atomic(destination/'policy.json',{'schema':1,'gateway_identity':context['identity'],'policy':snapshot})
        with target.open('rb') as stream:checksum=hashlib.file_digest(stream,'sha256').hexdigest()
        receipt={'schema':1,'kind':'local-sqlite','credential_backup':True,'snapshot':destination.name,
                 'sha256':checksum,'automatic_restore':False,'created_ns':time.time_ns()}
        atomic(destination/'receipt.json',receipt)
        # A pre-write database backup is not evidence of an ambiguous later write.
        return _retained(self.policy.root,context,receipt)
