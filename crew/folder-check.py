#!/usr/bin/env python3
"""Every bot runs in a folder that exists, with access to exactly the folders its jobs need. No AI.

    python3 folder-check.py [--hours N] [--no-logs] [--gaps] [--home DIR] [--db FILE]

One line per fault on stdout, exit 1 when there is any. It reads the engine's store read-only and each bot's own adapter rules (folders.py says
which), and checks, per bot:

  its folder exists; every folder its jobs need is allowed by its adapter (its folder, the folders of its bot file's `reads`, the job skill's
  folder, its scratch folder, the project folders and worktrees of the jobs given to it, the folders the studio's scripts write);
  nothing is wider than it should be (the keys, the owner's notes, the guards' files are not writable, nor readable where nobody may);
  and the runs of the last N hours (default 6) are scanned for refusals ("auto-rejecting", "external_directory", "Read-only file system",
  "outside writable roots", "cannot mount", "Operation not permitted", "Permission denied" on a path), and for a run that ended with exit 0 and
  no report right after one.

It never widens anything: the fix is in the bot's file or its adapter's config, and each line says where. --gaps also prints what no config can close.
The timetable runs it hourly; health.py runs it too.
"""
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import folders  # noqa: E402


def faults(env=None, db=None, hours=6, logs=True):
    """One line per fault (health.py's shape)."""
    return folders.faults(env, db, hours, logs).faults


def main(argv):
    def value(flag, default=None):
        return argv[argv.index(flag) + 1] if flag in argv and argv.index(flag) + 1 < len(argv) else default
    env = dict(os.environ)
    if value('--home'):
        env['BOTYARD_HOME'] = value('--home')
    result = folders.faults(env, value('--db'), float(value('--hours', 6)), '--no-logs' not in argv)
    for line in result.faults:
        print(line)
    if '--gaps' in argv:
        for line in result.gaps:
            print('gap:', line)
    print('folders: ok' if not result.faults else f'folders: {len(result.faults)} fault(s)')
    return 1 if result.faults else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
