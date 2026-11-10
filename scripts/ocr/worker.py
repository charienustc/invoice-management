"""Offline PP-OCRv6 worker. JSON-lines over inherited stdin/stdout only."""
import json
import pathlib
import socket
import sys


def no_network(*args, **kwargs):
    raise RuntimeError("Network access is disabled in the bundled OCR engine")


socket.socket.connect = no_network
socket.socket.connect_ex = no_network

import numpy as np
from rapidocr import RapidOCR

root = pathlib.Path(getattr(sys, "_MEIPASS", pathlib.Path(__file__).resolve().parent))
models = root / "models"
for name in ("PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx", "ch_ppocr_mobile_v2.0_cls_mobile.onnx"):
    if not (models / name).is_file():
        sys.exit("Bundled model is missing")

engine = RapidOCR(params={
    "Global.model_root_dir": str(models),
    "Det.model_path": str(models / "PP-OCRv6_det_small.onnx"),
    "Cls.model_path": str(models / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"),
    "Rec.model_path": str(models / "PP-OCRv6_rec_small.onnx"),
    "EngineConfig.onnxruntime.intra_op_num_threads": 4,
    "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    "EngineConfig.onnxruntime.use_cuda": False,
    "EngineConfig.onnxruntime.use_dml": False,
    "Global.log_level": "error",
})
# Load all sessions before reporting readiness; a constructor alone is lazy.
engine(np.full((64, 64, 3), 255, dtype=np.uint8))
print(json.dumps({"type": "ready", "protocol": 1}), flush=True)

for message in sys.stdin:
    request_id = None
    try:
        request = json.loads(message)
        request_id = request["id"]
        output = engine(request["path"])
        boxes = output.boxes if output.boxes is not None else []
        scores = output.scores if output.scores is not None else []
        lines = [{"text": text, "confidence": float(score), "bbox": box.tolist()}
                 for text, score, box in zip(output.txts or [], scores, boxes)]
        print(json.dumps({"id": request_id, "lines": lines}, ensure_ascii=True), flush=True)
    except Exception:
        # Do not echo input paths, invoice contents, or environment details.
        print(json.dumps({"id": request_id, "error": "recognition_failed"}), flush=True)
