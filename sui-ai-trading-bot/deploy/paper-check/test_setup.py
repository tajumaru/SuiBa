"""Offline unit/installer contracts; never installs files or starts a service."""
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent


class UnitTests(unittest.TestCase):
    def test_production_changes_only_identity_entrypoints_and_validation_deadline(self):
        def unit(name):
            result = configparser.ConfigParser(interpolation=None)
            result.read(HERE/name)
            return {section: dict(result[section]) for section in result.sections()}
        validation = unit('suiba-paper-check.service')
        production = unit('suiba-prod.service')
        self.assertEqual(production['Service']['type'], 'exec')
        self.assertEqual(production['Service']['restart'], 'no')
        self.assertNotIn('runtimemaxsec', production['Service'])
        self.assertNotIn('Install', production)
        self.assertEqual(production['Service']['execstart'],
                         '/usr/bin/python3 -I /usr/local/libexec/suiba-paper-check.py prod-run')
        self.assertEqual(production['Service']['execstoppost'],
                         '/usr/bin/python3 -I /usr/local/libexec/suiba-paper-check.py prod-post-stop')
        validation['Unit'].pop('description')
        production['Unit'].pop('description')
        validation['Service'].pop('runtimemaxsec')
        for value in (validation, production):
            value['Service'].pop('execstart')
            value['Service'].pop('execstoppost')
        self.assertEqual(production, validation)

    def test_setup_pins_every_distributed_file_and_verifies_every_unit(self):
        script = (HERE/'setup-paper-check.sh').read_text()
        entries = re.findall(r"'([^'|]+)\|([a-f0-9]{64})\|([^'|]+)\|([0-7]{3})'", script)
        self.assertEqual(len(entries), 13)
        self.assertEqual(len({name for name, *_ in entries}), 13)
        for name, digest, target, mode in entries:
            self.assertEqual(hashlib.sha256((HERE/name).read_bytes().replace(b'\r\n', b'\n')).hexdigest(), digest, name)
            if name.endswith(('.service', '.timer')):
                self.assertEqual(target, '/etc/systemd/system/'+name)
                self.assertEqual(mode, '644')
        units = re.search(r"^UNITS='([^']+)'", script, re.M).group(1).split()
        self.assertEqual(set(units), {name for name, *_ in entries if name.endswith(('.service', '.timer'))})
        self.assertEqual(len(units), len(set(units)))
        self.assertIn('suiba-prod.service', units)
        self.assertIn('suiba-prod-watchdog.service', units)
        self.assertIn('suiba-prod-watchdog.timer', units)
        self.assertFalse(any('prod-policy' in name or 'prod-policy' in target for name, _, target, _ in entries))
        # daemon-reload/verify are permitted, but installation never activates
        # a unit or boot target. The sole stop action retires old cutoff timers.
        self.assertNotRegex(script, r'(?m)^\s*systemctl\s+(?:start|restart|enable|preset)\b')

    def test_watchdog_is_an_independent_observer_with_explicit_timer_activation(self):
        service = configparser.ConfigParser(interpolation=None)
        service.read(HERE/'suiba-prod-watchdog.service')
        self.assertEqual(service['Service']['Type'], 'oneshot')
        self.assertEqual(service['Service']['Restart'], 'no')
        self.assertEqual(service['Service']['ExecStart'], '/usr/bin/python3 -I /usr/local/libexec/suiba-prod-watchdog.py')
        self.assertEqual(service['Service']['ProtectSystem'], 'strict')
        self.assertEqual(service['Service']['StateDirectory'], 'suiba-watchdog')
        self.assertEqual(service['Service']['StateDirectoryMode'], '0700')
        # su drops to the deploy user, then its existing sudo wrapper regains
        # root; NoNewPrivileges=yes would break that read-only request route.
        self.assertEqual(service['Service']['NoNewPrivileges'], 'no')
        self.assertNotIn('Install', service)
        for key in ('Requires', 'Wants', 'BindsTo', 'PartOf', 'OnFailure'):
            self.assertNotIn(key, service['Unit'])
        timer = configparser.ConfigParser(interpolation=None)
        timer.read(HERE/'suiba-prod-watchdog.timer')
        self.assertEqual(timer['Timer']['OnBootSec'], '2min')
        self.assertEqual(timer['Timer']['OnUnitActiveSec'], '5min')
        self.assertEqual(timer['Timer']['Unit'], 'suiba-prod-watchdog.service')
        self.assertEqual(timer['Install']['WantedBy'], 'timers.target')


@unittest.skipIf(os.name == 'nt', 'Bash/Linux installer gate')
class SetupGateTests(unittest.TestCase):
    def run_gate(self, states):
        script = (HERE/'setup-paper-check.sh').read_text()
        start = script.index("echo '== 1/5")
        end = script.index('for timer in $TIMERS; do', start)
        # Execute the real pre-install guard, ending before timer/file mutations.
        guard = "set -Eeuo pipefail\nfail() { exit 19; }\nSERVICE=suiba-paper-check.service\nPROD_SERVICE=suiba-prod.service\n" + script[start:end]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            command = root/'systemctl'
            command.write_text('#!/usr/bin/python3\nimport os,json,sys\nv=json.loads(os.environ["UNIT_STATES"])[sys.argv[2]]\nprint("\\n".join(k+"="+v[k] for k in ("LoadState","ActiveState","Job") if k in v))\nsys.exit(v.get("exit",0))\n')
            command.chmod(0o755)
            env = {**os.environ, 'PATH': str(root)+':'+os.environ['PATH'], 'UNIT_STATES': json.dumps(states)}
            return subprocess.run(['/bin/bash', '-c', guard], env=env, capture_output=True, timeout=5).returncode

    def states(self):
        return {name: {'LoadState': 'loaded', 'ActiveState': 'inactive', 'Job': ''}
                for name in ('suiba-paper-check.service', 'suiba-prod.service')}

    def test_first_install_and_quiescent_upgrade_are_allowed(self):
        self.assertEqual(self.run_gate(self.states()), 0)
        states = self.states()
        states['suiba-prod.service'].update(LoadState='not-found', exit=4)
        self.assertEqual(self.run_gate(states), 0)

    def test_neither_supervisor_can_be_replaced_while_running_transitioning_or_queued(self):
        for service in self.states():
            for state in ('active', 'activating', 'deactivating', 'reloading'):
                with self.subTest(service=service, state=state):
                    states = self.states(); states[service]['ActiveState'] = state
                    self.assertEqual(self.run_gate(states), 19)
            states = self.states(); states[service]['Job'] = '123'
            self.assertEqual(self.run_gate(states), 19)

    def test_unknown_unit_state_fails_closed(self):
        for value in ({'LoadState': 'error', 'exit': 1}, {'LoadState': 'loaded'},
                      {'LoadState': 'not-found', 'ActiveState': 'inactive', 'Job': '123', 'exit': 4}):
            states = self.states(); states['suiba-prod.service'] = value
            self.assertEqual(self.run_gate(states), 19)


if __name__ == '__main__':
    unittest.main(verbosity=2)
