"""Frozen v1 welcome-pack evidence for v2 migration.

These SHA-256 digests are of the original utf-8 HTML bodies shipped as
``seed:welcome:v1``. Migration may replace a row only when the *current
content bytes* hash-equal the digest for that stable entry id. Titles and
HTML markers are not consulted.
"""

from __future__ import annotations

V1_SEED_KEY = "seed:welcome:v1"
V1_FOLDER_TITLE = "Knorvia 入门灯塔"
V1_FOLDER_ID = "lib_seed_welcome_v1_root"

# entry_id → sha256(html.encode("utf-8")) of the unmodified v1 document
V1_HTML_DIGESTS: dict[str, str] = {
    "lib_seed_welcome_v1_overview": (
        "e9236f59a2482373e15946c3861f5f1d66d43ce84735424396d3a4db2c3e0c78"
    ),
    "lib_seed_welcome_v1_model": (
        "9d8429981db2b6e804bc56976f658ecd9bd0961315f1c3f2ada7c6f298d55fce"
    ),
    "lib_seed_welcome_v1_first_run": (
        "7be6d2043facd4986c41408afff9ae903e5deadc5898c161f899f7d599c4d2a0"
    ),
    "lib_seed_welcome_v1_map": ("7efe7129799a09507bf91591ecefa87cc02de07a05491e097bc410b0d2a87dc5"),
    "lib_seed_welcome_v1_api": ("6d37cd47d01b5ccf3d8ca393eb3a61419b4f52a8e14cfb976fa77e9412cec334"),
    "lib_seed_welcome_v1_providers": (
        "451639dc517c7248a8c68744426071794ef074046391259a4c7d9d6916354f55"
    ),
    "lib_seed_welcome_v1_verify": (
        "25ecad3808d6e56d098c696895da6c0db6eee7451763142b8cc3c1b17cf70d8f"
    ),
    "lib_seed_welcome_v1_workflow": (
        "c18621a9ff87137c6d77b1d84f07913173b01d373c4f81313c5d575aeb68fa83"
    ),
    "lib_seed_welcome_v1_safety": (
        "97d9224cfeeeda6cfe39f4a4f34ff8104879d21f321e62e79ca9db0fdcd93c92"
    ),
    "lib_seed_welcome_v1_next": (
        "968cbaebd9007d413614ff8aed99baa6c1129370d6940f2f89ac013e744d4745"
    ),
}
