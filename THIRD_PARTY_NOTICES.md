# 第三方组件与模型

根目录 MIT 许可证适用于本项目原创源码，不替代第三方许可证。

- Electron / Chromium：安装目录中的 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`。
- JavaScript 依赖：`resources/third-party-npm.json` 由锁文件生成，列出生产依赖版本、许可证标识和完整性信息。各包的版权与许可证文本保留在应用的 `resources/app.asar/node_modules/` 或 `app.asar.unpacked/node_modules/` 中；具体位置以安装包内容为准。
- OCR：安装目录 `resources/ocr/THIRD_PARTY_NOTICES.txt` 及 `resources/ocr/licenses/`，包括 Python、RapidOCR、ONNX Runtime 和相关依赖。ONNX Runtime 的完整 LICENSE 与 ThirdPartyNotices.txt 单独保留在 `licenses/onnxruntime/`。
- OCR 模型：RapidOCR 分发的模型声明保留在 `licenses/rapidocr-<版本>.dist-info/licenses/MODEL_LICENSES.md`；模型来源与 SHA-256 见源码 `scripts/ocr/models.json`。

`npm run verify:release` 检查关键许可证文件和锁文件许可元数据；它不是对所有第三方授权条件的法律意见。
