"""Allowlisted public diagnostics only. Never echo arbitrary SSH stderr."""
import json
import sys

CODES = frozenset('''ADMISSION_POLICY ADMISSION_LOCK ADMISSION_START_REQUEST
ADMISSION_ABORT_INHIBIT ADMISSION_QUIESCENT ADMISSION_PREVIOUS_RUN ADMISSION_RETRY_LATCH
ADMISSION_RETRY_MARKER ADMISSION_RETRY_CONSUMED ADMISSION_RETRY_PERMIT ADMISSION_PREVIOUS_STATUS
ADMISSION_PREVIOUS_EXIT ADMISSION_PREVIOUS_STOP ADMISSION_FRESH_GATE ADMISSION_RETRY_CONSUME
ADMISSION_RECORD RETRY_REVIEW RETRY_RUN RETRY_STOP RETRY_LOCK RETRY_CURRENT RETRY_CONSUMED
RETRY_ALREADY_APPROVED RETRY_RECORD'''.split())
UNITS = frozenset(('suiba-paper-check-cutoff.timer', 'suiba-paper-check-cutoff-6h.timer',
                   'suiba-paper-check-cutoff-24h.timer', 'suiba-paper-check-cutoff.service'))


def admission_summary(value):
    if value is None: return []
    if value == {'code': 'ADMISSION_EVIDENCE_INVALID'}:
        return ['- Admission evidence: ADMISSION_EVIDENCE_INVALID']
    if (type(value) is not dict or set(value) != {'version', 'at', 'operation', 'code', 'observed'} or
            value['version'] != 1 or type(value['at']) is not int or value['at'] < 0 or
            value['operation'] not in ('admit', 'approve-retry') or value['code'] not in CODES):
        raise ValueError()
    observed = value['observed']
    if type(observed) is not dict or not set(observed) <= {'unit', 'active_state', 'job_pending', 'permit_exists', 'consumed_exists', 'inhibit_exists'}:
        raise ValueError()
    for key, item in observed.items():
        if key == 'unit': valid = item in UNITS
        elif key == 'active_state': valid = item in ('active', 'activating', 'deactivating', 'inactive', 'failed', 'unknown')
        else: valid = type(item) is bool
        if not valid: raise ValueError()
    return [f"- Last admission failure: {value['code']} (at={value['at']}, operation={value['operation']})",
            '- Admission observations: ' + json.dumps(observed, sort_keys=True)]


def admission_history_summary(values):
    if type(values) is not list: return []
    valid = []
    for value in values[-5:]:
        try:
            if type(value) is not dict or set(value) != {'version', 'at', 'operation', 'code', 'observed'}:
                continue
            admission_summary(value)
            valid.append(value)
        except Exception:
            continue
    while valid and len(json.dumps(valid, sort_keys=True).encode('utf-8'))+1 > 4096:
        valid = valid[1:]
    if not valid: return []
    lines = ['- Admission failure history (oldest first):']
    for value in valid:
        lines.extend(line.replace('- Last admission failure:', '- History failure:', 1)
                     for line in admission_summary(value))
    return lines


if __name__ == '__main__':
    try:
        with open(sys.argv[1], 'rb') as source:
            raw = source.read(8193)
        if len(raw) <= 8192:
            codes = [line.removeprefix('PAPER_CHECK_REASON=') for line in raw.decode('utf-8').splitlines()
                     if line.startswith('PAPER_CHECK_REASON=')]
            if len(codes) == 1 and codes[0] in CODES:
                print(codes[0])
    except Exception:
        pass
