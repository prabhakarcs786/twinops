"""Optional role-scoped local pilot access. Browser credentials stay in HttpOnly sessions."""

from __future__ import annotations

import hmac
import os
import secrets
import time
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse

ROLES = {"viewer": 0, "investigator": 1, "approver": 2}


class AccessPolicy:
    def __init__(self, required: bool, origins: tuple[str, ...] = ()):
        self.required = required
        self.origins = set(origins)
        if required and "*" in self.origins:
            raise ValueError("Authenticated mode requires explicit allowed origins")
        self.tokens = {role: token for role, key in [("viewer", "TWINOPS_VIEWER_TOKEN"), ("investigator", "TWINOPS_INVESTIGATOR_TOKEN"),
                                                     ("approver", "TWINOPS_OPERATOR_TOKEN")]
                       if (token := os.environ.get(key))}
        if required and not self.tokens:
            raise ValueError("Authenticated mode requires a configured role token")
        if len(set(self.tokens.values())) != len(self.tokens):
            raise ValueError("Each role must have a different access token")
        self.sessions: dict[str, tuple[str, float]] = {}

    def token_role(self, token: str) -> str | None:
        return next((role for role, secret in self.tokens.items() if token and hmac.compare_digest(token.encode(), secret.encode())), None)

    def role(self, request: Request) -> str | None:
        token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if token:
            return self.token_role(token)
        session = self.sessions.get(request.cookies.get("twinops_session", ""))
        return session[0] if session and session[1] > time.time() else None

    def login(self, token: str) -> tuple[str, str] | None:
        role = self.token_role(token)
        if not role:
            return None
        self.sessions = {key: value for key, value in self.sessions.items() if value[1] > time.time()}
        if len(self.sessions) >= 1000:
            del self.sessions[next(iter(self.sessions))]
        sid = secrets.token_urlsafe(32)
        self.sessions[sid] = (role, time.time() + 3600)
        return sid, role

    def authorize(self, request: Request) -> JSONResponse | None:
        if not self.required or request.method == "OPTIONS" or not request.url.path.startswith("/api/") or request.url.path in {"/api/health", "/api/config", "/api/auth/session"}:
            return None
        role = self.role(request)
        if not role:
            return JSONResponse({"detail": "Sign in to access investigation evidence"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
        if request.method not in {"GET", "HEAD", "OPTIONS"} and request.cookies.get("twinops_session"):
            origin = request.headers.get("origin")
            if origin and urlsplit(origin).netloc != request.url.netloc and origin not in self.origins:
                return JSONResponse({"detail": "Cross-origin changes are refused"}, status_code=403)
        path = request.url.path
        needed = "viewer" if request.method in {"GET", "HEAD", "OPTIONS"} or "review-trials" in path else "investigator"
        if path.endswith("/decision") and "review-trials" not in path:
            needed = "approver"
        if path.endswith("/reveal"):
            needed = "investigator"
        if ROLES[role] < ROLES[needed]:
            return JSONResponse({"detail": f"{needed} role required"}, status_code=403)
        request.state.role = role
        return None
