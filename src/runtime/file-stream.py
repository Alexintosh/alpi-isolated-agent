#!/usr/bin/env python3
"""Bounded file-tree transport, used on both sides of the engine control channel.

The receiving host distrusts every byte. No archive extraction, links, special
files, ownership restoration or overwrite. Paths are opened relative to pinned
directory descriptors, with O_NOFOLLOW at every component.
"""
import base64
import hashlib
import json
import os
import signal
import stat
import sys

MAX_BYTES = 1024 * 1024 * 1024
MAX_ENTRIES = 20000
MAX_DEPTH = 64
CHUNK = 48 * 1024
MAX_LINE = 70 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
OWNER = ".harness-isolated-transfer"


def name_ok(value):
    return (isinstance(value, str) and value not in ("", ".", "..") and
            len(value.encode("utf-8")) <= 255 and
            not any(ord(c) < 32 or ord(c) == 127 or c in "/\\" for c in value))


def components(value):
    if not isinstance(value, str) or not value.startswith("/") or value == "/":
        raise ValueError("Invalid absolute path")
    parts = value[1:].split("/")
    if not all(name_ok(p) for p in parts):
        raise ValueError("Invalid path component")
    return parts


def open_directory(value):
    if value == "/":
        return os.open("/", DIR_FLAGS)
    parts = components(value)
    fd = os.open("/", DIR_FLAGS)
    try:
        for part in parts:
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def emit(record):
    sys.stdout.write(json.dumps(record, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stdout.flush()


def send(source, scan=False):
    parts = components(source)
    parent = open_directory("/" + "/".join(parts[:-1]) if len(parts) > 1 else "/")
    totals = {"entries": 0, "bytes": 0}
    if not scan:
        emit({"type": "begin", "version": 1})

    def visit(parent_fd, name, relative):
        if len(relative) > MAX_DEPTH or not name_ok(name):
            raise ValueError("Unsupported path")
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        directory = stat.S_ISDIR(before.st_mode)
        if not directory and (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1):
            raise ValueError("Links and special files are not transferable")
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK |
                     (os.O_DIRECTORY if directory else 0), dir_fd=parent_fd)
        try:
            initial = os.fstat(fd)
            if identity(initial) != identity(before):
                raise ValueError("Source changed")
            totals["entries"] += 1
            if totals["entries"] > MAX_ENTRIES:
                raise ValueError("Too many entries")
            if directory:
                if not scan:
                    emit({"type": "directory", "path": relative})
                for child in sorted(os.listdir(fd)):
                    visit(fd, child, relative + [child])
            else:
                totals["bytes"] += initial.st_size
                if totals["bytes"] > MAX_BYTES:
                    raise ValueError("Transfer size limit exceeded")
                if not scan:
                    emit({"type": "file", "path": relative, "size": initial.st_size,
                          "executable": bool(initial.st_mode & 0o111)})
                    digest, size = hashlib.sha256(), 0
                    while True:
                        chunk = os.read(fd, CHUNK)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > initial.st_size:
                            raise ValueError("Source grew")
                        digest.update(chunk)
                        emit({"type": "data", "value": base64.b64encode(chunk).decode("ascii")})
                    if size != initial.st_size:
                        raise ValueError("Source truncated")
                    emit({"type": "end-file", "sha256": digest.hexdigest()})
            if identity(os.fstat(fd)) != identity(initial):
                raise ValueError("Source changed during transfer")
        finally:
            os.close(fd)

    try:
        visit(parent, parts[-1], [parts[-1]])
        emit({"type": "summary" if scan else "finish", **totals})
    finally:
        os.close(parent)


def read_record():
    line = sys.stdin.buffer.readline(MAX_LINE + 1)
    if not line or len(line) > MAX_LINE or not line.endswith(b"\n"):
        raise ValueError("Incomplete or oversized transfer record")
    record = json.loads(line)
    if not isinstance(record, dict):
        raise ValueError("Invalid record")
    return record


def remove_contents(fd):
    # No guest-provided path strings are used for cleanup. Symlinks are unlinked,
    # never followed. A replaced top-level directory is not removed by receive().
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            try:
                remove_contents(child)
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=fd)
        else:
            os.unlink(name, dir_fd=fd)


def receive(destination, expected_totals=None, transaction=None):
    parts = components(destination)
    parent = open_directory("/" + "/".join(parts[:-1]) if len(parts) > 1 else "/")
    root_fd, output_fd, root_stat = None, None, None
    completed = False
    try:
        if read_record() != {"type": "begin", "version": 1}:
            raise ValueError("Unsupported protocol")
        # mkdir is exclusive: existing files, folders and symlinks are collisions.
        os.mkdir(parts[-1], 0o700, dir_fd=parent)
        root_fd = os.open(parts[-1], DIR_FLAGS, dir_fd=parent)
        root_stat = os.fstat(root_fd)
        if transaction is not None:
            marker = os.open(OWNER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
            try:
                os.write(marker, transaction.encode("ascii"))
                os.fsync(marker)
            finally:
                os.close(marker)
        directories = {()}
        entries, size, written, last_progress = 0, 0, 0, 0
        expected, file_written, digest = 0, 0, None
        while True:
            record = read_record()
            kind = record.get("type")
            if output_fd is not None:
                if kind == "data" and set(record) == {"type", "value"}:
                    if not isinstance(record["value"], str):
                        raise ValueError("Invalid data")
                    chunk = base64.b64decode(record["value"], validate=True)
                    if not 0 < len(chunk) <= CHUNK or file_written + len(chunk) > expected:
                        raise ValueError("Invalid chunk size")
                    view = memoryview(chunk)
                    while view:
                        view = view[os.write(output_fd, view):]
                    file_written += len(chunk)
                    written += len(chunk)
                    digest.update(chunk)
                    if written - last_progress >= 1024 * 1024:
                        emit({"type": "progress", "entries": entries, "bytes": written})
                        last_progress = written
                elif kind == "end-file" and set(record) == {"type", "sha256"}:
                    if file_written != expected or record["sha256"] != digest.hexdigest():
                        raise ValueError("File integrity check failed")
                    os.fsync(output_fd)
                    os.close(output_fd)
                    output_fd = None
                    emit({"type": "progress", "entries": entries, "bytes": written})
                else:
                    raise ValueError("Unexpected record inside file")
                continue
            if kind == "finish":
                if record != {"type": "finish", "entries": entries, "bytes": size} or not entries:
                    raise ValueError("Transfer totals differ")
                if expected_totals is not None and expected_totals != (entries, size):
                    raise ValueError("Transfer differs from preview")
                if sys.stdin.buffer.read(1):
                    raise ValueError("Trailing transfer data")
                os.fsync(root_fd)
                completed = True
                emit({"type": "complete", "entries": entries, "bytes": written})
                return
            relative = record.get("path")
            if (kind not in ("file", "directory") or not isinstance(relative, list) or
                    not 1 <= len(relative) <= MAX_DEPTH or not all(name_ok(p) for p in relative) or
                    tuple(relative[:-1]) not in directories):
                raise ValueError("Invalid entry path")
            entries += 1
            if entries > MAX_ENTRIES:
                raise ValueError("Too many entries")
            fd = os.dup(root_fd)
            try:
                for part in relative[:-1]:
                    next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
                    os.close(fd)
                    fd = next_fd
                if kind == "directory":
                    if set(record) != {"type", "path"}:
                        raise ValueError("Invalid directory record")
                    os.mkdir(relative[-1], 0o700, dir_fd=fd)
                    directories.add(tuple(relative))
                else:
                    expected = record.get("size")
                    if (set(record) != {"type", "path", "size", "executable"} or
                            type(expected) is not int or expected < 0 or
                            type(record["executable"]) is not bool or size + expected > MAX_BYTES):
                        raise ValueError("Invalid file size or mode")
                    size += expected
                    output_fd = os.open(relative[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                        0o700 if record["executable"] else 0o600, dir_fd=fd)
                    file_written, digest = 0, hashlib.sha256()
            finally:
                os.close(fd)
    finally:
        if output_fd is not None:
            os.close(output_fd)
        if root_fd is not None:
            try:
                if not completed:
                    remove_contents(root_fd)
                    current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                    if (current.st_dev, current.st_ino) == (root_stat.st_dev, root_stat.st_ino):
                        os.rmdir(parts[-1], dir_fd=parent)
            finally:
                os.close(root_fd)
        os.close(parent)


def finish_output(destination, transaction, discard):
    parts = components(destination)
    parent = open_directory("/" + "/".join(parts[:-1]) if len(parts) > 1 else "/")
    root_fd = None
    try:
        try:
            root_fd = os.open(parts[-1], DIR_FLAGS, dir_fd=parent)
        except FileNotFoundError:
            if discard:
                emit({"type": "discarded"})
                return
            raise
        info = os.fstat(root_fd)
        marker = os.open(OWNER, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
        try:
            marker_info = os.fstat(marker)
            if (not stat.S_ISREG(marker_info.st_mode) or marker_info.st_nlink != 1 or
                    marker_info.st_size != 64 or os.read(marker, 65) != transaction.encode("ascii")):
                raise ValueError("Output is not owned by this transfer")
        finally:
            os.close(marker)
        if discard:
            remove_contents(root_fd)
            current = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise ValueError("Output replaced")
            os.rmdir(parts[-1], dir_fd=parent)
        else:
            os.unlink(OWNER, dir_fd=root_fd)
            os.fsync(root_fd)
        emit({"type": "discarded" if discard else "committed"})
    finally:
        if root_fd is not None:
            os.close(root_fd)
        os.close(parent)


def cancelled(_signum, _frame):
    raise InterruptedError("Transfer cancelled")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    os.umask(0o077)
    try:
        if len(sys.argv) not in (3, 4, 5, 6) or sys.argv[1] not in ("send", "receive", "scan", "commit", "discard"):
            raise ValueError("Invalid operation")
        transaction = sys.argv[-1] if len(sys.argv) in (4, 6) else None
        if transaction is not None and (len(transaction) != 64 or any(c not in "0123456789abcdef" for c in transaction)):
            raise ValueError("Invalid transaction")
        if sys.argv[1] == "receive":
            if len(sys.argv) not in (3, 5, 6):
                raise ValueError("Invalid arguments")
            expected = tuple(int(value) for value in sys.argv[3:5]) if len(sys.argv) >= 5 else None
            receive(sys.argv[2], expected, transaction)
        elif sys.argv[1] in ("commit", "discard"):
            if len(sys.argv) != 4:
                raise ValueError("Invalid arguments")
            finish_output(sys.argv[2], transaction, sys.argv[1] == "discard")
        else:
            if len(sys.argv) != 3:
                raise ValueError("Invalid arguments")
            send(sys.argv[2], scan=sys.argv[1] == "scan")
    except BaseException:
        # Never return file contents, paths, parser excerpts or a traceback.
        sys.stderr.write("File transfer rejected or interrupted.\n")
        sys.exit(1)
