#!/usr/bin/env python3
"""The crew's health: runs each check and exits non-zero when any fails. No AI.

    python3 health.py        one line per fault, then a summary
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)


def load(file):
    spec = importlib.util.spec_from_file_location(file.replace('-', '_').replace('.py', ''), os.path.join(HERE, file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHECKS = {'identity': lambda: load('identity-check.py').faults(repos=[os.path.dirname(HERE)]),
          'connectors': lambda: load('connectors-check.py').faults()}


def main():
    bad = 0
    for name, check in CHECKS.items():
        found = check()
        bad += len(found)
        for line in found:
            print(f'{name}: {line}')
    print('health: ok' if not bad else f'health: {bad} fault(s)')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
