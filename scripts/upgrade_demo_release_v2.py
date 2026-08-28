#!/usr/bin/env python3
"""Create the immutable Gate 1 V2 package from the checksum-pinned V1 package."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data/generated/logiplan-2026-demo-data.json"
TARGET = ROOT / "data/generated/logiplan-2026-demo-data-v2.json"
SOURCE_SHA256 = "4d7285a9d3cbe0671e98be3f0409e01847870a824f41e53fe4e4d8532862c674"
SOURCE_DATASET_ID = "LOGIPLAN_2026_DEMO_V1"
TARGET_DATASET_ID = "LOGIPLAN_2026_DEMO_V2"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    if sha256(SOURCE) != SOURCE_SHA256:
        raise RuntimeError("V1 发布包校验和不匹配，拒绝生成 V2")
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    if data["metadata"]["dataset_id"] != SOURCE_DATASET_ID:
        raise RuntimeError("V1 发布包 dataset_id 不匹配")
    data["metadata"]["dataset_id"] = TARGET_DATASET_ID
    TARGET.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"{TARGET.relative_to(ROOT)} sha256={sha256(TARGET)}")


if __name__ == "__main__":
    main()
