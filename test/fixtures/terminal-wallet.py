"""Exercise the actual PTY ownership boundary. Inputs are public offline fixtures."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

node, fixture, config, key = sys.argv[1:]
password = 'public terminal test password'
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ.pop('DAOSHIPS_KEYSTORE_PASSWORD_FILE', None)
    os.environ.pop('DAOSHIPS_NEW_PASSWORD_FILE', None)
    os.execv(node, [node, fixture, config])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 34, 112, 0, 0))
all_output = b''
pending = b''

def until(marker, timeout=15):
    global all_output, pending
    deadline = time.monotonic() + timeout
    marker = marker.encode()
    while marker not in pending:
        if time.monotonic() > deadline:
            raise AssertionError('Timed out at terminal checkpoint: ' + marker.decode())
        if select.select([fd], [], [], 0.1)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    raise AssertionError('Terminal process exited before checkpoint') from None
                raise
            if not data:
                raise AssertionError('Terminal process closed before checkpoint')
            all_output += data
            pending += data
    pending = pending.split(marker, 1)[1]

def send(value):
    os.write(fd, value.encode())
    time.sleep(0.08)

def command(name):
    send('\x0b')
    until('Go anywhere')
    send(name)
    send('\r')
    until('STEP 1 OF')

try:
    until('DAOShips')
    command('wallet import')
    send('terminal')
    send('\r')
    until('STEP 2 OF')
    send('\r')
    until('Private key (hidden):')
    send(key + '\x14\r')  # Ctrl T must not reveal a private key.
    until('New keystore password')
    send(password + '\x14\r')
    until('Repeat new password:')
    send(password + '\r')
    until('"active": true')
    send('\x1b')
    command('wallet verify')
    send('\r')
    until('Keystore password:')
    send('incorrect public password\r')
    until('Check its password and integrity')
    send('\x1b')
    command('wallet verify')
    send('\r')
    until('Keystore password:')
    send('\x03')
    until('Secret entry cancelled')
    send('\x1b')
    command('wallet verify')
    send('\r')
    until('Keystore password:')
    send(password + '\r')
    until('"verified": true')
    send('\x1b')
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    os.kill(pid, signal.SIGWINCH)
    until('Quit')
    send('q')
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            assert os.waitstatus_to_exitcode(status) == 0
            break
        time.sleep(0.05)
    else:
        raise AssertionError('TUI did not exit after terminal handoff')
    assert key.encode() not in all_output, 'Private key was echoed'
    assert password.encode() not in all_output, 'Password was echoed'
    assert b'incorrect public password' not in all_output, 'Wrong password was echoed'
    print(json.dumps({'imported': True, 'wrongPasswordRejected': True, 'cancelRestoredTui': True, 'verified': True, 'secretsHidden': True}))
finally:
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except ProcessLookupError:
        pass
    os.close(fd)
