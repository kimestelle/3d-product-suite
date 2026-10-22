"""Canonical World Labs generation identity shared by local and GitHub runners."""
from __future__ import annotations

import hashlib
import json

DEFAULT_PROMPT = (
    "A refined botanical product photography studio with warm limestone walls, "
    "subtle olive foliage in the distant background, and soft daylight from a large side window. "
    "Leave the central foreground empty for a separately modeled small skincare bottle and its pedestal. "
    "No products, labels, typography, people, or floating objects. Calm, realistic materials."
)
DEFAULT_ENVIRONMENTS = {
    "botanical-studio": DEFAULT_PROMPT,
    "warm-gallery": "A quiet warm limestone art gallery, soft side light, subtle natural materials and an empty foreground for a separately modeled product and pedestal. No products, labels, text or people.",
    "modern-loft": "A refined modern loft with muted concrete, distant greenery and diffuse window light. Leave the central foreground empty for a separately modeled product and pedestal. No products, labels, text or people.",
}


def identity_from_fingerprint(prompt_sha256, model, seed=42):
    document = {"schemaVersion": 1, "provider": "worldlabs", "model": model,
                "seed": seed, "promptSha256": prompt_sha256}
    return hashlib.sha256(json.dumps(document, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def generation_identity(*, prompt="", preset="botanical-studio", model="marble-1.1", image_url="",
                        image_sha256=None, seed=42):
    """Hash provider inputs only; callers must not persist the returned prompt."""
    effective_prompt = prompt.strip() or DEFAULT_ENVIRONMENTS[preset]
    fingerprint = hashlib.sha256(json.dumps({"prompt": effective_prompt,
        "image": image_sha256 or image_url.strip()}, sort_keys=True).encode()).hexdigest()
    return {"key": identity_from_fingerprint(fingerprint, model, seed), "promptSha256": fingerprint,
            "model": model, "seed": seed, "prompt": effective_prompt}
