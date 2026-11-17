"""Offline workflow contracts for the single-approval production release.

The release workflow chains validate, package and one executing job
(stop, deploy, start as sequential steps) in a single run. These
tests pin that shape: exactly one sakura-vps Environment and it sits
on the job that runs the SSH steps (GitHub scopes Environment
secrets to the declaring job — the PR #228 gate-job shape left the
executing jobs with empty VPS_* secrets and the first live run
failed before contacting the host), the needs: ordering, the step
order inside the executing job, the repository-variable enable
gates, and the reuse of the fixed SSH wrappers and broker path.
Never contacts a VPS.
"""
import ast
from pathlib import Path
import re
import unittest

HERE = Path(__file__).parent
WORKFLOWS = HERE.parent.parent/'.github/workflows'
WORKFLOW = WORKFLOWS/'suiba-release.yml'
CONTROL = WORKFLOWS/'suiba-production-control.yml'
VPS = WORKFLOWS/'suiba-vps.yml'

JOBS = ('validate', 'package-image', 'prod-release')
SECRETS = ('VPS_HOST', 'VPS_USER', 'VPS_PORT', 'VPS_SSH_KEY', 'VPS_KNOWN_HOSTS')


def job_block(source, name):
    block = source.split(f'  {name}:\n', 1)[1]
    return re.split(r'\n  [a-z][a-z0-9-]*:\n', block, maxsplit=1)[0]


def needs_of(block):
    match = re.search(r'    needs: (.+)\n', block)
    if match is None:
        return []
    value = match.group(1).strip()
    if value.startswith('['):
        return [item.strip() for item in value.strip('[]').split(',') if item.strip()]
    return [value]


def evaluate(expression, context):
    expr = expression
    for key, value in context.items():
        expr = expr.replace(key, repr(value))
    expr = ' '.join(expr.replace('&&', ' and ').split())
    tree = ast.parse(expr, mode='eval')
    assert all(isinstance(node, (ast.Expression, ast.BoolOp, ast.And, ast.Compare,
                                 ast.Eq, ast.Constant)) for node in ast.walk(tree))
    return eval(compile(tree, '<workflow-gate>', 'eval'), {'__builtins__': {}})


def gate_expression(block):
    return re.search(r'    if: (.+)\n', block).group(1)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.source = WORKFLOW.read_text(encoding='utf-8')
        self.blocks = {name: job_block(self.source, name) for name in JOBS}

    def test_only_a_confirmation_input_and_no_schedule(self):
        self.assertIn('workflow_dispatch:', self.source)
        self.assertNotIn('schedule:', self.source)
        self.assertIn('Type RELEASE-PROD', self.source)
        self.assertEqual(self.source.count('inputs:'), 1)

    def test_exactly_one_environment_on_the_executing_job(self):
        # Regression test for run 43328855984 (2026-11-13): the
        # environment sat on a no-op gate job, so the jobs running
        # the SSH steps received no Environment secrets and the stop
        # failed with every VPS_* value empty. Any job whose steps
        # reference the VPS_* secrets must be the one declaring the
        # environment.
        self.assertEqual(self.source.count('environment: sakura-vps'), 1)
        self.assertNotIn('sakura-vps-observe', self.source)
        self.assertIn('environment: sakura-vps', self.blocks['prod-release'])
        for name in ('validate', 'package-image'):
            self.assertNotIn('environment:', self.blocks[name], name)
        jobs_using_secrets = {name for name in JOBS
                              if 'secrets.VPS_' in self.blocks[name]}
        self.assertEqual(jobs_using_secrets, {'prod-release'})

    def test_jobs_are_defined_in_release_order(self):
        positions = [self.source.index(f'  {name}:\n') for name in JOBS]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(needs_of(self.blocks['validate']), [])
        self.assertEqual(needs_of(self.blocks['package-image']), [])
        self.assertEqual(set(needs_of(self.blocks['prod-release'])),
                         {'validate', 'package-image'})

    def test_serialized_with_the_control_group_and_never_cancelled(self):
        self.assertIn('group: suiba-production-control', self.source)
        self.assertIn('cancel-in-progress: false', self.source)

    def test_no_always_and_no_second_start_path(self):
        # A failure must halt the chain with production left in the
        # state the completed steps reached: no step may run
        # unconditionally, and each fixed wrapper may appear only
        # once (no auto-restart of the previous release hidden
        # elsewhere).
        self.assertNotIn('if: always()', self.source)
        self.assertEqual(self.source.count('ssh-prod-start.sh'), 1)
        self.assertEqual(self.source.count('ssh-prod-stop.sh'), 1)
        self.assertEqual(self.source.count('production-followup.py'), 2)

    def test_phase_a_gates_require_dispatch_main_and_release_confirmation(self):
        for name in ('validate', 'package-image'):
            expression = gate_expression(self.blocks[name])
            for event in ('workflow_dispatch', 'push'):
                for ref in ('refs/heads/main', 'refs/heads/feature'):
                    for confirmation in ('RELEASE-PROD', 'DEPLOY-PAPER', 'wrong', ''):
                        actual = evaluate(expression, {
                            'github.event_name': event, 'github.ref': ref,
                            'inputs.confirmation': confirmation})
                        expected = (event == 'workflow_dispatch' and ref == 'refs/heads/main'
                                    and confirmation == 'RELEASE-PROD')
                        self.assertEqual(actual, expected, (name, event, ref, confirmation))

    def test_release_gate_requires_both_enable_variables(self):
        expression = gate_expression(self.blocks['prod-release'])
        for control in ('true', 'false', ''):
            for broker in ('true', 'false', ''):
                for ref in ('refs/heads/main', 'refs/heads/feature'):
                    for confirmation in ('RELEASE-PROD', 'wrong', ''):
                        actual = evaluate(expression, {
                            'vars.SUIBA_PROD_CONTROL_ENABLED': control,
                            'vars.SUIBA_BROKER_ENABLED': broker,
                            'github.ref': ref, 'inputs.confirmation': confirmation})
                        expected = (control == 'true' and broker == 'true'
                                    and ref == 'refs/heads/main'
                                    and confirmation == 'RELEASE-PROD')
                        self.assertEqual(actual, expected,
                                         (control, broker, ref, confirmation))

    def test_phase_a_reuses_the_deploy_validation_and_packaging(self):
        validate = self.blocks['validate']
        self.assertIn('pnpm install --frozen-lockfile', validate)
        self.assertIn('vitest.no-worker.config.ts', validate)
        package = self.blocks['package-image']
        self.assertIn('archive_sha256: ${{ steps.package.outputs.archive_sha256 }}', package)
        self.assertIn('name: vps-release', package)
        self.assertIn("ARCHIVE_SHA256: ${{ needs.package-image.outputs.archive_sha256 }}",
                      self.blocks['prod-release'])

    def test_release_steps_run_in_stop_deploy_start_order(self):
        block = self.blocks['prod-release']
        markers = [
            'Record what this release deploys',
            'actions/download-artifact@',
            'ssh-prod-stop.sh',
            'PROD_FOLLOWUP_MODE: stop',
            'Transfer and deploy with pinned SSH host identity',
            'ssh-prod-start.sh',
            'PROD_FOLLOWUP_MODE: start',
        ]
        positions = [block.index(marker) for marker in markers]
        self.assertEqual(positions, sorted(positions))

    def test_release_job_reuses_wrappers_followup_and_broker_path(self):
        release = self.blocks['prod-release']
        self.assertIn('timeout-minutes: 30', release)
        # The released commit and archive digest are summarized for
        # the record before anything state-changing runs.
        self.assertIn('Release archive sha256', release)
        self.assertIn('$GITHUB_STEP_SUMMARY', release)
        # Stop through the fixed wrapper, then its follow-up read.
        self.assertIn('id: stop', release)
        self.assertIn('run: bash sui-ai-trading-bot/docker/ssh-prod-stop.sh', release)
        # The wrappers accept only their own fixed words; the release
        # confirmation itself is enforced by the job gate above.
        self.assertIn('PROD_STOP_CONFIRMATION: STOP-PROD', release)
        self.assertIn("if: steps.stop.outputs.outcome == 'completed'", release)
        self.assertIn('PROD_FOLLOWUP_MODE: stop', release)
        # Deploy through the broker with the packaged artifact.
        self.assertIn('actions/download-artifact@', release)
        self.assertIn('name: vps-release', release)
        self.assertIn("'sudo -n -- /usr/local/sbin/suiba-deploy'", release)
        self.assertIn('"operation":"deploy"', release)
        self.assertIn('RELEASE_SHA: ${{ github.sha }}', release)
        self.assertIn('SSH_KEY: ${{ secrets.VPS_SSH_KEY }}', release)
        self.assertIn('KNOWN_HOSTS: ${{ secrets.VPS_KNOWN_HOSTS }}', release)
        # Start through the fixed wrapper, then its follow-up read.
        self.assertIn('run: bash sui-ai-trading-bot/docker/ssh-prod-start.sh', release)
        self.assertIn('PROD_START_CONFIRMATION: START-PROD', release)
        self.assertIn('PROD_FOLLOWUP_MODE: start', release)
        self.assertEqual(
            release.count('run: python3 sui-ai-trading-bot/docker/production-followup.py'), 2)
        for secret in SECRETS:
            self.assertIn(f'{secret}: ${{{{ secrets.{secret} }}}}', release)


class LegacyWorkflowTests(unittest.TestCase):
    """The standalone paths keep their own approvals and gates."""

    def test_control_workflow_keeps_three_environment_approvals(self):
        source = CONTROL.read_text(encoding='utf-8')
        self.assertEqual(source.count('environment: sakura-vps'), 3)
        self.assertIn('Type START-PROD, STOP-PROD or ROLLBACK-PROD', source)

    def test_vps_workflow_keeps_its_deploy_approval(self):
        source = VPS.read_text(encoding='utf-8')
        self.assertIn('environment: sakura-vps', job_block(source, 'deploy'))
        self.assertIn('DEPLOY-PAPER', source)


if __name__ == '__main__':
    unittest.main(verbosity=2)
