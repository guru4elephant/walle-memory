"""Small, fail-closed macOS Keychain adapter for profile-specific API keys.

Importing this module and constructing MacOSKeychain perform no Keychain access.
Only explicit get()/add() calls load the Apple frameworks and call item APIs.
There is no subprocess, environment-variable, file, or storage-backend fallback.

Items use the current macOS user's default file-based Keychain (usually login),
are non-synchronizable, and are always searched in that one explicit Keychain.
No Data Protection entitlement is assumed. The file-based Keychain's lock state
and executable ACL apply: this does NOT assert ThisDeviceOnly, biometric access,
automatic locking with the screen, or skill-specific isolation from other code
run by the same Python interpreter. Apple's classic APIs remain in the checked
SDK, but are deprecated.

Both operations disable classic Keychain authentication UI through
SecKeychainSetUserInteractionAllowed and reject a locked Keychain. This switch
is process-global: run the adapter in a dedicated CLI process, not alongside
unrelated threaded Keychain clients. A local lock serializes this module's own
calls; UI is never re-enabled by this adapter. Query UIFail alone is insufficient
for the classic implementation. Native behavior has deliberately not been tested
against real Keychain items in this candidate.

The caller must obtain separate authorization before user-led credential setup.
The caller must never log a returned key, pass one on a command line, or expose an
exception traceback with local variables. Python cannot guarantee erasure of the
immutable strings returned by get() or supplied to add().
"""

from __future__ import annotations

import ctypes
import sys
import threading
from contextlib import contextmanager


__all__ = ["MacOSKeychain", "KeychainError", "KeychainMissing", "KeychainExists"]


class KeychainError(RuntimeError):
    """An error whose message is fixed and contains no native or secret text."""


class KeychainMissing(KeychainError):
    """The selected service/account has no accessible stored credential."""


class KeychainExists(KeychainError):
    """The selected service/account already exists; no replacement was made."""


_UNAVAILABLE = "The macOS local Keychain is unavailable."
_OPERATION_FAILED = "The Keychain operation failed."
_MISSING = "No credential is available for the selected Keychain reference."
_ACCESS_DENIED = "Keychain access is locked or denied; no authorization UI was opened."
_ENTITLEMENT = "This process is not authorized for the selected Keychain."
_EXISTS = "The Keychain reference already exists; it was not changed."
_BAD_REFERENCE = "The Keychain reference is invalid."
_BAD_SECRET = "The Keychain credential is invalid."

_SUCCESS = 0
_DUPLICATE_ITEM = -25299
_ITEM_NOT_FOUND = -25300
_AUTH_FAILED = -25293
_INTERACTION_NOT_ALLOWED = -25308
_MISSING_ENTITLEMENT = -34018
_NATIVE_LOCK = threading.RLock()


def _validate_reference(service: str, account: str) -> None:
    try:
        for value in (service, account):
            if not isinstance(value, str) or not value or "\x00" in value:
                raise ValueError
            if len(value.encode("utf-8")) > 512 or not value.isprintable():
                raise ValueError
    except Exception:
        raise KeychainError(_BAD_REFERENCE) from None


def _encode_secret(secret: str) -> bytes:
    try:
        if not isinstance(secret, str):
            raise ValueError
        encoded = secret.encode("ascii", "strict")
        if not 1 <= len(encoded) <= 512 or any(b < 32 or b > 126 for b in encoded):
            raise ValueError
        return encoded
    except Exception:
        raise KeychainError(_BAD_SECRET) from None


def _decode_secret(encoded: bytes) -> str:
    try:
        if not 1 <= len(encoded) <= 512 or any(b < 32 or b > 126 for b in encoded):
            raise ValueError
        return encoded.decode("ascii", "strict")
    except Exception:
        raise KeychainError(_BAD_SECRET) from None


def _check_status(status: int, *, adding: bool = False) -> None:
    if status == _SUCCESS:
        return
    if adding and status == _DUPLICATE_ITEM:
        raise KeychainExists(_EXISTS)
    if status == _ITEM_NOT_FOUND:
        raise KeychainMissing(_MISSING)
    if status in (_AUTH_FAILED, _INTERACTION_NOT_ALLOWED):
        raise KeychainError(_ACCESS_DENIED)
    if status == _MISSING_ENTITLEMENT:
        raise KeychainError(_ENTITLEMENT)
    raise KeychainError(_OPERATION_FAILED)


class _DictionaryKeyCallbacks(ctypes.Structure):
    _fields_ = [("version", ctypes.c_long)] + [
        (name, ctypes.c_void_p)
        for name in ("retain", "release", "copyDescription", "equal", "hash")
    ]


class _DictionaryValueCallbacks(ctypes.Structure):
    _fields_ = [("version", ctypes.c_long)] + [
        (name, ctypes.c_void_p)
        for name in ("retain", "release", "copyDescription", "equal")
    ]


class _ArrayCallbacks(ctypes.Structure):
    _fields_ = [("version", ctypes.c_long)] + [
        (name, ctypes.c_void_p)
        for name in ("retain", "release", "copyDescription", "equal")
    ]


class _NativeAPI:
    """Lazy Apple framework bindings; creation itself does not query items."""

    def __init__(self) -> None:
        if sys.platform != "darwin":
            raise KeychainError(_UNAVAILABLE)
        try:
            self.cf = ctypes.CDLL(
                "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
            )
            self.security = ctypes.CDLL(
                "/System/Library/Frameworks/Security.framework/Security"
            )
            self.constants = {
                name: ctypes.c_void_p.in_dll(self.security, name).value
                for name in (
                    "kSecClass", "kSecClassGenericPassword", "kSecAttrService",
                    "kSecAttrAccount", "kSecAttrSynchronizable",
                    "kSecUseDataProtectionKeychain", "kSecMatchSearchList", "kSecUseKeychain",
                    "kSecReturnData", "kSecMatchLimit", "kSecMatchLimitOne",
                    "kSecValueData",
                )
            }
            self.constants["true"] = ctypes.c_void_p.in_dll(self.cf, "kCFBooleanTrue").value
            self.constants["false"] = ctypes.c_void_p.in_dll(self.cf, "kCFBooleanFalse").value
            if not all(self.constants.values()):
                raise ValueError
            self._key_callbacks = _DictionaryKeyCallbacks.in_dll(
                self.cf, "kCFTypeDictionaryKeyCallBacks"
            )
            self._value_callbacks = _DictionaryValueCallbacks.in_dll(
                self.cf, "kCFTypeDictionaryValueCallBacks"
            )
            self._array_callbacks = _ArrayCallbacks.in_dll(self.cf, "kCFTypeArrayCallBacks")
            self._bind()
        except Exception:
            raise KeychainError(_UNAVAILABLE) from None

    def _bind(self) -> None:
        pointer = ctypes.c_void_p
        pointer_array = ctypes.POINTER(pointer)
        byte_pointer = ctypes.POINTER(ctypes.c_ubyte)
        signatures = (
            (self.cf, "CFStringCreateWithCString", [pointer, ctypes.c_char_p, ctypes.c_uint32], pointer),
            (self.cf, "CFDataCreate", [pointer, byte_pointer, ctypes.c_long], pointer),
            (self.cf, "CFArrayCreate", [pointer, pointer_array, ctypes.c_long,
                ctypes.POINTER(_ArrayCallbacks)], pointer),
            (self.cf, "CFDictionaryCreate", [pointer, pointer_array, pointer_array, ctypes.c_long,
                ctypes.POINTER(_DictionaryKeyCallbacks), ctypes.POINTER(_DictionaryValueCallbacks)], pointer),
            (self.cf, "CFGetTypeID", [pointer], ctypes.c_ulong),
            (self.cf, "CFDataGetTypeID", [], ctypes.c_ulong),
            (self.cf, "CFDataGetLength", [pointer], ctypes.c_long),
            (self.cf, "CFDataGetBytePtr", [pointer], byte_pointer),
            (self.cf, "CFRelease", [pointer], None),
            (self.security, "SecItemCopyMatching", [pointer, ctypes.POINTER(pointer)], ctypes.c_int32),
            (self.security, "SecItemAdd", [pointer, ctypes.POINTER(pointer)], ctypes.c_int32),
            (self.security, "SecKeychainCopyDefault", [ctypes.POINTER(pointer)], ctypes.c_int32),
            (self.security, "SecKeychainGetStatus", [pointer, ctypes.POINTER(ctypes.c_uint32)], ctypes.c_int32),
            (self.security, "SecKeychainSetUserInteractionAllowed", [ctypes.c_ubyte], ctypes.c_int32),
        )
        for library, name, arguments, result in signatures:
            function = getattr(library, name)
            function.argtypes = arguments
            function.restype = result

    def make_string(self, value: str) -> int:
        result = self.cf.CFStringCreateWithCString(None, value.encode("utf-8"), 0x08000100)
        if not result:
            raise KeychainError(_OPERATION_FAILED)
        return result

    def make_data(self, value: bytes) -> int:
        buffer = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
        try:
            result = self.cf.CFDataCreate(None, buffer, len(value))
            if not result:
                raise KeychainError(_OPERATION_FAILED)
            return result
        finally:
            # Best effort for this temporary C buffer only, not Python strings.
            ctypes.memset(buffer, 0, len(value))

    def make_dictionary(self, pairs: list[tuple[int, int]]) -> int:
        keys = (ctypes.c_void_p * len(pairs))(*(key for key, _ in pairs))
        values = (ctypes.c_void_p * len(pairs))(*(value for _, value in pairs))
        result = self.cf.CFDictionaryCreate(
            None, keys, values, len(pairs),
            ctypes.byref(self._key_callbacks), ctypes.byref(self._value_callbacks),
        )
        if not result:
            raise KeychainError(_OPERATION_FAILED)
        return result

    def make_array(self, values: list[int]) -> int:
        references = (ctypes.c_void_p * len(values))(*values)
        result = self.cf.CFArrayCreate(
            None, references, len(values), ctypes.byref(self._array_callbacks)
        )
        if not result:
            raise KeychainError(_OPERATION_FAILED)
        return result

    def copy_default(self) -> tuple[int, int | None]:
        result = ctypes.c_void_p()
        status = self.security.SecKeychainCopyDefault(ctypes.byref(result))
        return int(status), result.value

    def keychain_status(self, keychain: int) -> tuple[int, int]:
        flags = ctypes.c_uint32()
        status = self.security.SecKeychainGetStatus(keychain, ctypes.byref(flags))
        return int(status), int(flags.value)

    def disable_interaction(self) -> None:
        _check_status(int(self.security.SecKeychainSetUserInteractionAllowed(False)))

    def copy_matching(self, query: int) -> tuple[int, int | None]:
        result = ctypes.c_void_p()
        status = self.security.SecItemCopyMatching(query, ctypes.byref(result))
        return int(status), result.value

    def add_item(self, query: int) -> int:
        # No returned object is requested; no item read or preflight query occurs.
        return int(self.security.SecItemAdd(query, None))

    def data_bytes(self, result: int) -> bytes:
        if self.cf.CFGetTypeID(result) != self.cf.CFDataGetTypeID():
            raise KeychainError(_BAD_SECRET)
        length = self.cf.CFDataGetLength(result)
        if not 1 <= length <= 512:
            raise KeychainError(_BAD_SECRET)
        pointer = self.cf.CFDataGetBytePtr(result)
        if not pointer:
            raise KeychainError(_BAD_SECRET)
        return ctypes.string_at(pointer, length)

    def release(self, owned: int) -> None:
        self.cf.CFRelease(owned)


def _load_native() -> _NativeAPI:
    return _NativeAPI()


@contextmanager
def _noninteractive(api: _NativeAPI):
    with _NATIVE_LOCK:
        api.disable_interaction()
        yield


def _open_default(api: _NativeAPI, owned: list[int], *, adding: bool) -> int:
    status, keychain = api.copy_default()
    if keychain:
        owned.append(keychain)
    _check_status(status)
    if not keychain:
        raise KeychainError(_UNAVAILABLE)
    status, flags = api.keychain_status(keychain)
    _check_status(status)
    # SecKeychainStatus bits: unlocked=1, read=2, write=4. No unlock call exists.
    required = 1 | (4 if adding else 2)
    if flags & required != required:
        raise KeychainError(_ACCESS_DENIED)
    return keychain


def _release_owned(api: _NativeAPI, owned: list[int]) -> None:
    failed = False
    for reference in reversed(owned):
        try:
            api.release(reference)
        except Exception:
            failed = True
    if failed:
        raise KeychainError(_OPERATION_FAILED) from None


class MacOSKeychain:
    """Exact service/account lookup and add-only storage, with no fallback."""

    def __init__(self) -> None:
        self._api: _NativeAPI | None = None

    def _native(self) -> _NativeAPI:
        if self._api is None:
            self._api = _load_native()
        return self._api

    @staticmethod
    def _base_pairs(api: _NativeAPI, service: int, account: int) -> list[tuple[int, int]]:
        c = api.constants
        return [
            (c["kSecClass"], c["kSecClassGenericPassword"]),
            (c["kSecAttrService"], service),
            (c["kSecAttrAccount"], account),
            (c["kSecUseDataProtectionKeychain"], c["false"]),
        ]

    def get(self, service: str, account: str) -> str:
        """Return one exact reference; missing/locked/denied accesses fail closed."""
        _validate_reference(service, account)
        owned: list[int] = []
        api = None
        try:
            api = self._native()
            with _noninteractive(api):
                keychain = _open_default(api, owned, adding=False)
                search_list = api.make_array([keychain])
                owned.append(search_list)
                service_ref = api.make_string(service)
                owned.append(service_ref)
                account_ref = api.make_string(account)
                owned.append(account_ref)
                pairs = self._base_pairs(api, service_ref, account_ref)
                c = api.constants
                pairs.extend([
                    # Omit Synchronizable here: the documented default excludes
                    # synchronizable items and permits this exact search list.
                    (c["kSecMatchSearchList"], search_list),
                    (c["kSecReturnData"], c["true"]),
                    (c["kSecMatchLimit"], c["kSecMatchLimitOne"]),
                ])
                query = api.make_dictionary(pairs)
                owned.append(query)
                status, result = api.copy_matching(query)
                if result:
                    owned.append(result)
                _check_status(status)
                if not result:
                    raise KeychainError(_BAD_SECRET)
                return _decode_secret(api.data_bytes(result))
        except KeychainError:
            raise
        except Exception:
            raise KeychainError(_OPERATION_FAILED) from None
        finally:
            if api is not None:
                _release_owned(api, owned)

    def add(self, service: str, account: str, secret: str) -> None:
        """Add a new local item; duplicates fail without reading or replacing it."""
        _validate_reference(service, account)
        encoded = _encode_secret(secret)
        owned: list[int] = []
        api = None
        try:
            api = self._native()
            with _noninteractive(api):
                keychain = _open_default(api, owned, adding=True)
                service_ref = api.make_string(service)
                owned.append(service_ref)
                account_ref = api.make_string(account)
                owned.append(account_ref)
                secret_ref = api.make_data(encoded)
                owned.append(secret_ref)
                pairs = self._base_pairs(api, service_ref, account_ref)
                c = api.constants
                pairs.extend([
                    (c["kSecUseKeychain"], keychain),
                    (c["kSecAttrSynchronizable"], c["false"]),
                    (c["kSecValueData"], secret_ref),
                ])
                query = api.make_dictionary(pairs)
                owned.append(query)
                _check_status(api.add_item(query), adding=True)
        except KeychainError:
            raise
        except Exception:
            raise KeychainError(_OPERATION_FAILED) from None
        finally:
            if api is not None:
                _release_owned(api, owned)
