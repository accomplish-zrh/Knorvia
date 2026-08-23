"""Frozen fingerprints for the welcome pack shipped as version 2.

Only byte-identical built-in pages are eligible for an automatic v3 refresh.
Anything the owner edited remains untouched.
"""

from __future__ import annotations

V2_SEED_KEY = "seed:welcome:v2"

V2_HTML_DIGESTS: dict[str, str] = {
    "lib_seed_welcome_v1_overview": "ef70fbb96a1dd874093af451c475e03535c640af7d520577bc5e5a976cf55f8b",
    "lib_seed_welcome_v1_model": "3f1331f38c2823918b0abe9b60ac2456a288d855356f0c8008340337fce41e02",
    "lib_seed_welcome_v1_first_run": "f15fdbc9e8575013976fc00cc436164a3e9362d592ff0c1668fb9b32aec4a113",
    "lib_seed_welcome_v1_map": "94f1e914430e09f941cac2082c49fa72e26e547afd6b6240b72dfa03f1b21cf4",
    "lib_seed_welcome_v1_api": "239da0d14ae917e39b60bc7d8e0878e2d29cbbb5772c337bf0e5ef0ff6b9c6b1",
    "lib_seed_welcome_v1_providers": "e479017bc9c525d2a7e990d386761379ee384cb5fdd772095e2f0436878ce03c",
    "lib_seed_welcome_v1_verify": "09e9ce2d633b71380acb1b2e68c746dc8ace6d229921a90352b28c31a46274bd",
    "lib_seed_welcome_v1_workflow": "cc0aadee61d158239aa85fd2ec6fde1e141e05f9f17ea60a3811a8f60e4dac86",
    "lib_seed_welcome_v1_safety": "9643b9524ebdd002833892e4dee8c78b61488919047e11666b7fc80b47d7a8ff",
    "lib_seed_welcome_v1_next": "12ba1a185df6936eacef9bacc723e57c7c0899d6bd9a7cd1d0f6001b68bd71f9",
}
