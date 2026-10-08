#!/usr/bin/env python3
"""Install Stormo's local router scripts on Linux."""

from __future__ import annotations

import os
import stat
import sys
import tempfile
from datetime import datetime
from pathlib import Path

SOURCE_FILES = (
    'route-ask',
    'route_workflow.py',
    'route_budget.py',
    'glm-ask',
    'SKILL.md',
)
EXECUTABLES = frozenset(('route-ask', 'glm-ask'))


class SetupError(Exception):
    pass


def read_sources(source_dir):
    missing = [name for name in SOURCE_FILES if not (source_dir / name).is_file()]
    if missing:
        raise SetupError('Missing or irregular source files: ' + ', '.join(missing))

    contents = {}
    failures = []
    for name in SOURCE_FILES:
        try:
            data = (source_dir / name).read_bytes()
            data.decode('utf-8')
            contents[name] = data.replace(b"\r\n", b"\n")
        except (OSError, UnicodeDecodeError) as exc:
            failures.append('{}: {}'.format(name, exc))

    if failures:
        raise SetupError('Could not read all sources: ' + '; '.join(failures))
    return contents


def existing_regular_file(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise SetupError('The path exists but is not a regular file: {}'.format(path))
    return info


def write_temporary(directory, prefix, contents, mode):
    fd, temporary_name = tempfile.mkstemp(
        prefix='.' + prefix + '.', suffix='.tmp', dir=str(directory)
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, 'wb') as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    return temporary


def remove_temporary(path):
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def make_backup(destination, contents, mode):
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    index = 0
    while True:
        suffix = '' if index == 0 else '-{}'.format(index)
        backup = destination.with_name(
            '{}.{}{}.bak'.format(destination.name, stamp, suffix)
        )
        temporary = write_temporary(
            destination.parent, destination.name + '.backup', contents, mode
        )
        try:
            try:
                # The hard link creates the backup name without overwriting an existing backup.
                os.link(str(temporary), str(backup))
                return backup
            except FileExistsError:
                index += 1
        finally:
            remove_temporary(temporary)


def install_file(name, contents, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    executable = name in EXECUTABLES
    install_mode = 0o755 if executable else 0o644

    info = existing_regular_file(destination)
    if info is not None and destination.read_bytes() == contents:
        if executable:
            current_mode = stat.S_IMODE(info.st_mode)
            executable_mode = current_mode | 0o111
            if executable_mode != current_mode:
                destination.chmod(executable_mode)
        print('Already present with identical content: {}'.format(destination))
        return 'identico'

    temporary = write_temporary(
        destination.parent, destination.name, contents, install_mode
    )
    backup = None
    was_present = False
    try:
        current_info = existing_regular_file(destination)
        if current_info is not None:
            current_contents = destination.read_bytes()
            if current_contents == contents:
                if executable:
                    current_mode = stat.S_IMODE(current_info.st_mode)
                    executable_mode = current_mode | 0o111
                    if executable_mode != current_mode:
                        destination.chmod(executable_mode)
                print('Already present with identical content: {}'.format(destination))
                return 'identico'
            backup = make_backup(
                destination,
                current_contents,
                stat.S_IMODE(current_info.st_mode),
            )
            was_present = True

        # The temporary file is in the same directory: the replacement is atomic.
        os.replace(str(temporary), str(destination))
    finally:
        remove_temporary(temporary)

    if was_present:
        print('Replaced: {} (backup: {})'.format(destination, backup))
        return 'replaced'
    print('Newly installed: {}'.format(destination))
    return 'new'


def local_bin_is_in_path(local_bin):
    wanted = os.path.realpath(str(local_bin))
    for entry in os.environ.get('PATH', '').split(os.pathsep):
        if not entry:
            continue
        expanded = os.path.expandvars(os.path.expanduser(entry))
        if os.path.realpath(os.path.abspath(expanded)) == wanted:
            return True
    return False


def main():
    if os.name != 'posix' or sys.platform != 'linux':
        print('This setup only works on Linux.', file=sys.stderr)
        return 1
    if os.geteuid() == 0:
        print('Run this setup as a normal user, not as root or with sudo.', file=sys.stderr)
        return 1

    try:
        source_dir = Path(__file__).resolve().parent
        contents = read_sources(source_dir)
        home = Path.home()
    except (OSError, RuntimeError, SetupError) as exc:
        print('Setup aborted: {}'.format(exc), file=sys.stderr)
        return 1

    local_bin = home / '.local' / 'bin'
    skill_path = home / '.claude' / 'skills' / 'model-router' / 'SKILL.md'
    destinations = (
        *((name, local_bin / name) for name in SOURCE_FILES[:-1]),
        ('SKILL.md', skill_path),
    )

    try:
        for name, destination in destinations:
            install_file(name, contents[name], destination)
    except (OSError, SetupError) as exc:
        print('Installation aborted: {}'.format(exc), file=sys.stderr)
        print('Already-installed files remain in place.', file=sys.stderr)
        return 1

    if local_bin_is_in_path(local_bin):
        print('PATH: ~/.local/bin is already present.')
    else:
        print('PATH: ~/.local/bin is not present.')
        print('For Bash or Zsh, manually add this line to your shell startup file:')
        print('  export PATH="$HOME/.local/bin:$PATH"')
        print('Then open a new shell, or reload the current one.')
        print('No login or configuration file was modified automatically.')

    print('If you updated the PATH, reopen the shell and restart Stormo to refresh the environment.')
    print('Setup complete. Personal credentials and configurations were not modified.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
