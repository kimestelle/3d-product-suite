"""Small export vocabulary shared by the queue and durable workers."""

FORMATS = {
    "png": ("still", "still.png"),
    "jpeg": ("still", "still.jpg"),
    "webp": ("still", "still.webp"),
    "mp4": ("reel", "film.mp4"),
    "prores": ("reel", "film.mov"),
    "png-sequence": ("reel", "frames.zip"),
}


def validate_format(kind, value=None):
    value = ("png" if kind == "still" else "mp4") if value is None else value
    if not isinstance(value, str) or value not in FORMATS or FORMATS[value][0] != kind:
        choices = ", ".join(key for key, entry in FORMATS.items() if entry[0] == kind)
        raise ValueError(f"{kind} export format must be one of: {choices}")
    return value


def job_format(job):
    return validate_format(job.get("kind", "reel"), job["renderProfile"].get("format"))


def primary_artifact(job):
    return FORMATS[job_format(job)][1]


def artifact_names(job):
    primary = primary_artifact(job)
    if job.get("kind") == "still":
        return (primary, "scene.blend")
    if job_format(job) == "png-sequence":
        return (primary, "scene.blend")
    return (primary, "scene.blend", "still-01.png", "still-02.png", "still-03.png", "contact-sheet.png")
