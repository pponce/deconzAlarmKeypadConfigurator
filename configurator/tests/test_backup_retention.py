"""Retention uses synthetic snapshots and never operates on host backups."""
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from configurator import backup
from configurator.common import atomic


IDENTITY = 'A' * 16
CONTEXT = {'gateway': 'test', 'identity': IDENTITY}
POLICY = {'identities': {'user': {'user_revision': 1}},
          'grants': {'1': {'user': {'revision': 1}}}}


class BackupRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = self.root / 'backups'
        self.store.mkdir(mode=0o700)
        self.policy = backup.PolicyBackup(str(self.store))

    def save(self, context=CONTEXT):
        return self.policy.save(context, POLICY)

    def folders(self):
        return {p.name for p in self.store.iterdir() if p.is_dir()}

    def twenty(self):
        return [self.save() for _ in range(20)]

    def test_twenty_newest_policy_snapshots_and_unrelated_material(self):
        unrelated = self.store / 'migration' / 'configurator-policy-old'
        unrelated.mkdir(parents=True)
        (unrelated / 'keep').write_bytes(b'migration evidence')
        for _ in range(3):
            self.save({'gateway': 'other', 'identity': 'B' * 16})
        rows = [self.save() for _ in range(25)]
        self.assertEqual({r['snapshot'] for r in rows} & self.folders(),
                         {r['snapshot'] for r in rows[-20:]})
        self.assertEqual(len(self.folders()), 24)
        self.assertEqual((unrelated / 'keep').read_bytes(), b'migration evidence')

    def test_database_snapshots_have_independent_limit_and_readable_latest(self):
        policies = self.twenty()
        source = self.root / 'gateway.sqlite'
        source.touch(mode=0o600)
        with sqlite3.connect(source) as db:
            db.execute('CREATE TABLE gateway_users_v2(uid TEXT, revision INTEGER, hash TEXT)')
            db.execute('CREATE TABLE alarm_user_grants_v2(alarm INTEGER, uid TEXT, revision INTEGER)')
            db.execute("INSERT INTO gateway_users_v2 VALUES('user',1,'synthetic-verifier')")
            db.execute("INSERT INTO alarm_user_grants_v2 VALUES(1,'user',1)")
        adapter = backup.Backups(str(self.store), [{'id': 'test', 'identity': IDENTITY}],
                                 [{'gateway': 'test', 'identity': IDENTITY, 'path': str(source)}])
        rows = [adapter.save(CONTEXT, POLICY) for _ in range(22)]
        self.assertTrue(all((self.store / r['snapshot']).exists() for r in policies))
        self.assertEqual(len(self.folders()), 40)
        self.assertFalse((self.store / rows[0]['snapshot']).exists())
        latest = self.store / rows[-1]['snapshot'] / 'gateway.sqlite'
        with sqlite3.connect(latest.as_uri() + '?mode=ro', uri=True) as db:
            self.assertEqual(db.execute('PRAGMA quick_check').fetchone(), ('ok',))
        self.assertEqual(adapter.status()[0]['retention_limit'], 20)

    def test_legacy_receipts_use_receipt_timestamp_without_rewriting_kept_receipts(self):
        rows = self.twenty()
        original = {}
        for index, row in enumerate(rows):
            path = self.store / row['snapshot'] / 'receipt.json'
            old = dict(row); old.pop('created_ns')
            atomic(path, old)
            os.utime(path, ns=(index + 1, index + 1))
            original[path] = path.read_bytes()
        self.save()
        self.assertFalse((self.store / rows[0]['snapshot']).exists())
        for path, raw in list(original.items())[1:]:
            self.assertEqual(path.read_bytes(), raw)

    def test_new_backup_kept_if_clock_moves_backwards(self):
        rows = self.twenty()
        with patch.object(backup.time, 'time_ns', return_value=1):
            new = self.save()
        self.assertTrue((self.store / new['snapshot']).is_dir())
        self.assertFalse((self.store / rows[0]['snapshot']).exists())
        self.assertEqual(len(self.folders()), 20)

    def test_failed_backup_does_not_prune_existing_snapshots(self):
        rows = self.twenty()
        original = backup.atomic
        def fail_receipt(path, value):
            if path.name == 'receipt.json':
                raise OSError('synthetic disk error')
            return original(path, value)
        with patch.object(backup, 'atomic', fail_receipt):
            with self.assertRaises(OSError):
                self.save()
        self.assertTrue(all((self.store / r['snapshot']).is_dir() for r in rows))
        self.assertEqual(len(self.folders()), 21)  # Incomplete folder is not eligible.

    def test_unexpected_files_pins_links_and_unrelated_gateway_are_preserved(self):
        rows = self.twenty()
        pinned = self.store / rows[0]['snapshot']
        (pinned / '.keep').touch(mode=0o600)
        linked = self.store / rows[1]['snapshot']
        outside = self.root / 'outside'
        linked.rename(outside)
        linked.symlink_to(outside, target_is_directory=True)
        hardlink = self.store / rows[2]['snapshot'] / 'policy.json'
        os.link(hardlink, self.root / 'policy-link')
        partial = self.store / 'configurator-policy-incomplete'
        partial.mkdir(mode=0o700)
        (partial / 'policy.json').write_bytes(b'partial')
        for _ in range(5):
            self.save()
        self.assertTrue(pinned.is_dir())
        self.assertTrue(linked.is_symlink())
        self.assertTrue((outside / 'receipt.json').exists())
        self.assertTrue(hardlink.exists())
        self.assertEqual((partial / 'policy.json').read_bytes(), b'partial')
        self.assertEqual(len(self.folders()), 24)

    def test_corrupted_deletion_candidate_is_kept_and_failure_does_not_reject_new_backup(self):
        rows = self.twenty()
        corrupted = self.store / rows[0]['snapshot'] / 'policy.json'
        data = json.loads(corrupted.read_text()); data['policy']['extra'] = True
        atomic(corrupted, data)
        with self.assertLogs('configurator.backup', level='WARNING'):
            new = self.save()
        self.assertTrue(corrupted.exists())
        self.assertTrue((self.store / new['snapshot']).exists())

    def test_cleanup_error_and_interruption_preserve_current_backup(self):
        rows = self.twenty()
        oldest = self.store / rows[0]['snapshot']
        original = backup.os.unlink
        def interrupt(name, *args, **kwargs):
            if name == 'receipt.json':
                raise OSError('synthetic interruption')
            return original(name, *args, **kwargs)
        with patch.object(backup.os, 'unlink', interrupt), self.assertLogs('configurator.backup', level='WARNING'):
            new = self.save()
        self.assertTrue((oldest / 'receipt.json').exists())
        self.assertFalse((oldest / 'policy.json').exists())
        self.assertTrue((self.store / new['snapshot'] / 'policy.json').exists())
        self.save()
        self.assertTrue((oldest / 'receipt.json').exists())

    def test_no_pruning_when_latest_metadata_does_not_match(self):
        rows = self.twenty()
        before = self.folders()
        with self.assertRaises(Exception):
            backup.retain(self.store, CONTEXT, dict(rows[-1], sha256='0' * 64))
        self.assertEqual(self.folders(), before)


if __name__ == '__main__':
    unittest.main()
