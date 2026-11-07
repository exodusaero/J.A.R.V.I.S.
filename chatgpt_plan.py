"""Local Sign in with ChatGPT plan integration for JARVIS.

This is the documented open-source / locally hosted OAuth flow, not a
ChatGPT website scraper and not a standard billable API-key integration.
Tokens stay on the local Python host, never in the HUD's JavaScript.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib import error, parse, request


AUTH_URL = "https://auth.openai.com/api/accounts/authorize"
TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
JWKS_URL = "https://auth.openai.com/.well-known/jwks.json"
REVOCATION_DISCOVERY = "https://auth.openai.com/.well-known/openid-configuration"
API_URL = "https://api.openai.com/v1"
ISSUER = "https://auth.openai.com"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
MAX_STREAM_BYTES = 2_000_000
MAX_HISTORY_MESSAGES = 16


class ChatGPTPlanError(RuntimeError):
    """Safe, user-facing error for ChatGPT plan operations."""


def _base64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _json_request(url: str, *, payload: dict[str, Any] | None = None,
                  token: str | None = None, form: bool = False) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    data = None
    if payload is not None:
        if form:
            data = parse.urlencode(payload).encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        with request.urlopen(request.Request(url, data=data, headers=headers), timeout=20) as response:
            raw = response.read(256_001)
        if len(raw) > 256_000:
            raise ChatGPTPlanError("The authentication service returned an oversized response.")
        answer = json.loads(raw)
        if not isinstance(answer, dict):
            raise ValueError("Expected an object")
        return answer
    except error.HTTPError as exc:
        if exc.code in {401, 403}:
            raise ChatGPTPlanError("ChatGPT authorization was denied or expired. Please reconnect.") from exc
        if exc.code == 429:
            raise ChatGPTPlanError("Your ChatGPT plan usage limit was reached. Check ChatGPT Settings → Usage.") from exc
        raise ChatGPTPlanError(f"The OpenAI service returned HTTP {exc.code}.") from exc
    except (error.URLError, TimeoutError) as exc:
        raise ChatGPTPlanError("Could not reach OpenAI. Check your internet connection.") from exc
    except (ValueError, UnicodeError) as exc:
        raise ChatGPTPlanError("OpenAI returned an invalid response.") from exc


def _atomic_private_json(path: Path, value: dict[str, Any]) -> None:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")
    if len(raw) > 64_000:
        raise ChatGPTPlanError("The credential record exceeded its size limit.")
    if path.is_symlink():
        raise ChatGPTPlanError("Refusing to store credentials through a symbolic link.")
    descriptor, temporary = tempfile.mkstemp(prefix=".chatgpt-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class ChatGPTPlan:
    """Single-user local account, OAuth and inference manager.

    This is intentionally not a multi-tenant web authentication provider.
    JARVIS's web server remains loopback-only; remote phone access requires a
    private, separately authenticated connection to that local host.
    """

    def __init__(self, data_dir: Path, *, port: int, model: str = "gpt-6.1-sol") -> None:
        self.directory = data_dir.expanduser().resolve() / "chatgpt-plan"
        if self.directory.is_symlink():
            raise ChatGPTPlanError("The ChatGPT data directory cannot be a symbolic link.")
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.directory, 0o700)
        self.credentials_path = self.directory / "credentials.json"
        self.host_path = self.directory / "host.json"
        self.redirect_uri = f"http://127.0.0.1:{port}/auth/callback"
        self.preferred_model = model
        self._lock = threading.RLock()
        self._pending: dict[str, Any] | None = None
        self._models_cache: tuple[float, list[dict[str, str]]] | None = None
        self._credentials = self._read_private(self.credentials_path)
        host = self._read_private(self.host_path)
        if host and isinstance(host.get("host_id"), str) and host["host_id"].startswith("urn:uuid:"):
            self.host_id = host["host_id"]
        else:
            self.host_id = "urn:uuid:" + str(uuid.uuid4())
            _atomic_private_json(self.host_path, {"host_id": self.host_id})

    @staticmethod
    def _read_private(path: Path) -> dict[str, Any] | None:
        if path.is_symlink():
            raise ChatGPTPlanError("Refusing to read credentials through a symbolic link.")
        if not path.exists():
            return None
        if path.stat().st_mode & 0o077:
            raise ChatGPTPlanError("Private ChatGPT credential permissions are too broad (require 0600).")
        if path.stat().st_size > 64_000:
            raise ChatGPTPlanError("Private ChatGPT credential file is too large.")
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(result, dict):
                raise ValueError("Expected an object")
            return result
        except (ValueError, UnicodeError) as exc:
            raise ChatGPTPlanError("The ChatGPT account file is invalid.") from exc

    def status(self) -> dict[str, Any]:
        with self._lock:
            credentials = self._credentials
            return {
                "enabled": True,
                "connected": bool(credentials and credentials.get("refresh_token") and
                                  "chatgpt.tokens.use.direct" in credentials.get("scopes", [])),
                "email": str(credentials.get("email", "")) if credentials else "",
                "model": self.preferred_model,
                "usage_url": "https://chatgpt.com/#settings/Usage",
            }

    def start_sign_in(self) -> str:
        with self._lock:
            state = secrets.token_urlsafe(32)
            verifier = secrets.token_urlsafe(64)
            nonce = secrets.token_urlsafe(32)
            previous = self._credentials
            client_id = previous.get("client_id") if previous else None
            self._pending = {"state": state, "verifier": verifier, "nonce": nonce,
                             "client_id": client_id, "expires": time.monotonic() + 600}
            params = {
                "client_id": client_id or "dynamic_agent_client",
                "ext_agent_host_id": self.host_id,
                "response_type": "code",
                "redirect_uri": self.redirect_uri,
                "scope": SCOPES,
                "resource": API_URL,
                "state": state,
                "nonce": nonce,
                "code_challenge_method": "S256",
                "code_challenge": _base64url(hashlib.sha256(verifier.encode("ascii")).digest()),
            }
            if not client_id:
                params["agent_name_hint"] = "J.A.R.V.I.S."
            elif previous:
                if previous.get("id_token"):
                    params["id_token_hint"] = previous["id_token"]
                if previous.get("email"):
                    params["login_hint"] = previous["email"]
            return AUTH_URL + "?" + parse.urlencode(params)

    @staticmethod
    def _verify_identity(id_token: str, client_id: str, nonce: str) -> dict[str, Any]:
        try:
            import jwt
            key = jwt.PyJWKClient(JWKS_URL).get_signing_key_from_jwt(id_token)
            claims = jwt.decode(id_token, key.key, algorithms=["RS256"],
                                issuer=ISSUER, audience=client_id,
                                options={"require": ["sub", "exp", "iat"]}, leeway=5)
        except ImportError as exc:
            raise ChatGPTPlanError("Install the ChatGPT integration with pip install -e '.[chatgpt]'.") from exc
        except Exception as exc:
            raise ChatGPTPlanError("OpenAI identity verification failed. Please sign in again.") from exc
        if claims.get("nonce") != nonce or not isinstance(claims.get("sub"), str) or not claims["sub"]:
            raise ChatGPTPlanError("The ChatGPT sign-in identity did not match this request.")
        return claims

    def finish_sign_in(self, query: dict[str, list[str]]) -> str:
        with self._lock:
            pending, self._pending = self._pending, None
            received_state = query.get("state", [""])[0]
            if (not pending or time.monotonic() > pending["expires"] or
                    not secrets.compare_digest(received_state, pending["state"])):
                raise ChatGPTPlanError("Sign-in expired or could not be verified. Start again.")
            if "error" in query:
                raise ChatGPTPlanError("ChatGPT permission was not granted.")
            code = query.get("code", [""])[0]
            supplied_id = query.get("client_id", [""])[0]
            issued_id = pending["client_id"] or supplied_id
            if not code or not issued_id or issued_id == "dynamic_agent_client":
                raise ChatGPTPlanError("The ChatGPT registration was incomplete.")
            if pending["client_id"] and supplied_id and supplied_id != pending["client_id"]:
                raise ChatGPTPlanError("The ChatGPT account registration changed unexpectedly.")
            answer = _json_request(TOKEN_URL, payload={
                "grant_type": "authorization_code", "client_id": issued_id,
                "code": code, "code_verifier": pending["verifier"],
                "redirect_uri": self.redirect_uri, "resource": API_URL,
            }, form=True)
            claims = self._verify_identity(str(answer.get("id_token", "")), issued_id, pending["nonce"])
            scopes = str(answer.get("scope", "")).split()
            if "chatgpt.tokens.use.direct" not in scopes:
                raise ChatGPTPlanError("ChatGPT plan usage was not approved. Reconnect and enable plan usage.")
            if not answer.get("access_token") or not answer.get("refresh_token"):
                raise ChatGPTPlanError("The ChatGPT connection has incomplete credentials.")
            previous = self._credentials
            if previous and previous.get("subject") and previous["subject"] != claims["sub"]:
                raise ChatGPTPlanError("This JARVIS installation is linked to a different ChatGPT account.")
            record = {"client_id": issued_id, "subject": claims["sub"],
                      "email": claims.get("email", ""), "id_token": answer["id_token"],
                      "access_token": answer["access_token"], "refresh_token": answer["refresh_token"],
                      "scopes": scopes, "saved_at": time.time(),
                      "expires_in": int(answer.get("expires_in", 3600))}
            _atomic_private_json(self.credentials_path, record)
            self._credentials = record
            self._models_cache = None
            return "Your ChatGPT plan is connected to JARVIS. You can return to the HUD."

    def _access_token(self) -> str:
        with self._lock:
            record = self._credentials
            if not record or "chatgpt.tokens.use.direct" not in record.get("scopes", []):
                raise ChatGPTPlanError("Connect your ChatGPT Plus account in the JARVIS panel first.")
            if time.time() < float(record.get("saved_at", 0)) + int(record.get("expires_in", 0)) - 90:
                return str(record["access_token"])
            answer = _json_request(TOKEN_URL, payload={
                "grant_type": "refresh_token", "client_id": record["client_id"],
                "refresh_token": record["refresh_token"], "resource": API_URL,
            }, form=True)
            if not answer.get("access_token") or not answer.get("refresh_token"):
                raise ChatGPTPlanError("ChatGPT session refresh failed. Please reconnect.")
            updated = dict(record, access_token=answer["access_token"],
                           refresh_token=answer["refresh_token"],
                           saved_at=time.time(), expires_in=int(answer.get("expires_in", 3600)))
            if "scope" in answer:
                updated["scopes"] = str(answer["scope"]).split()
            if "chatgpt.tokens.use.direct" not in updated["scopes"]:
                raise ChatGPTPlanError("ChatGPT plan usage permission was revoked. Please reconnect.")
            _atomic_private_json(self.credentials_path, updated)
            self._credentials = updated
            return str(updated["access_token"])

    def models(self) -> list[dict[str, str]]:
        with self._lock:
            if self._models_cache and self._models_cache[0] > time.monotonic():
                return list(self._models_cache[1])
            result = _json_request(API_URL + "/models", token=self._access_token())
            choices = [{"slug": x["slug"], "name": x.get("display_name", x["slug"])}
                       for x in result.get("models", [])
                       if isinstance(x, dict) and x.get("visibility") == "list" and
                       isinstance(x.get("slug"), str)]
            if not choices:
                raise ChatGPTPlanError("No ChatGPT plan models were returned for this account.")
            if self.preferred_model not in {choice["slug"] for choice in choices}:
                self.preferred_model = choices[0]["slug"]
            self._models_cache = (time.monotonic() + 300, choices)
            return list(choices)

    def select_model(self, slug: str) -> str:
        if not isinstance(slug, str) or not slug or len(slug) > 120:
            raise ChatGPTPlanError("Select a model from the ChatGPT plan list.")
        with self._lock:
            if slug not in {choice["slug"] for choice in self.models()}:
                raise ChatGPTPlanError("That model is not available on this ChatGPT plan.")
            self.preferred_model = slug
            return slug

    def respond(self, prompt: str, history: list[dict[str, str]]) -> str:
        token = self._access_token()
        available = self.models()
        names = {m["slug"] for m in available}
        model = self.preferred_model if self.preferred_model in names else available[0]["slug"]
        messages = [{"role": pair["role"], "content": pair["content"][:3000]}
                    for pair in history[-MAX_HISTORY_MESSAGES:]
                    if pair.get("role") in {"user", "assistant"} and isinstance(pair.get("content"), str)]
        messages.append({"role": "user", "content": prompt})
        payload = {
            "model": model, "input": messages, "store": False, "stream": True,
            "instructions": (
                "You are J.A.R.V.I.S., a careful British engineering assistant. "
                "Address the user as Sir, be candid, precise, and helpful. "
                "This ChatGPT-plan mode supports conversation only; do not claim to "
                "have run Mac tools, seen the screen, browsed the web, or accessed "
                "the user's ChatGPT account memories. Ask before assuming facts."
            ),
        }
        req = request.Request(API_URL + "/responses", json.dumps(payload).encode("utf-8"),
                              {"Authorization": "Bearer " + token,
                               "Content-Type": "application/json", "Accept": "text/event-stream"})
        parts: list[str] = []
        completed = False
        size = 0
        try:
            with request.urlopen(req, timeout=120) as stream:
                for line in stream:
                    size += len(line)
                    if size > MAX_STREAM_BYTES:
                        raise ChatGPTPlanError("The model response exceeded the permitted size.")
                    if not line.startswith(b"data: "):
                        continue
                    data = line[6:].strip()
                    if data == b"[DONE]":
                        break
                    try:
                        event = json.loads(data)
                    except ValueError:
                        continue
                    kind = event.get("type") if isinstance(event, dict) else ""
                    if kind == "response.output_text.delta" and isinstance(event.get("delta"), str):
                        parts.append(event["delta"])
                    elif kind == "response.completed":
                        completed = True
                    elif kind == "response.failed":
                        code = (event.get("response") or {}).get("error") or {}
                        if code.get("code", "").startswith("subscription_sharing_"):
                            raise ChatGPTPlanError("ChatGPT plan usage is unavailable or exhausted. Check ChatGPT Settings → Usage.")
                        raise ChatGPTPlanError("OpenAI could not complete this response.")
                    elif kind in {"response.incomplete", "error"}:
                        raise ChatGPTPlanError("The model response was interrupted or incomplete.")
        except error.HTTPError as exc:
            if exc.code in {401, 403}:
                raise ChatGPTPlanError("ChatGPT authorization is no longer valid. Reconnect your account.") from exc
            if exc.code == 429:
                raise ChatGPTPlanError("Your ChatGPT plan usage limit was reached. Check ChatGPT Settings → Usage.") from exc
            raise ChatGPTPlanError(f"OpenAI inference returned HTTP {exc.code}.") from exc
        except (error.URLError, TimeoutError) as exc:
            raise ChatGPTPlanError("Could not finish the ChatGPT response. Check your connection.") from exc
        if not completed:
            raise ChatGPTPlanError("The response stream ended before OpenAI confirmed completion.")
        result = "".join(parts).strip()
        if not result:
            raise ChatGPTPlanError("The model returned no text.")
        return result


class ChatGPTPlanAssistant:
    """Minimal assistant adapter for the existing local orb and SQLite memory."""

    def __init__(self, plan: ChatGPTPlan, toolkit: Any) -> None:
        self.plan = plan
        self.toolkit = toolkit
        self.client = None  # Plan authorization does not include Ollama vision.
        self._lock = threading.Lock()

    def ask(self, user_text: str) -> str:
        if not isinstance(user_text, str) or not user_text.strip() or len(user_text) > 8000:
            raise ChatGPTPlanError("Enter a message of no more than 8,000 characters.")
        with self._lock:
            history = self.toolkit.memory.recent_history(8)
            reply = self.plan.respond(user_text.strip(), history)
            self.toolkit.memory.save_turn(user_text, reply)
            return reply
