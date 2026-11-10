# 内置 OCR 构建

应用使用 PP-OCRv6 small 检测/识别模型，通过 RapidOCR 和 ONNX Runtime CPU 执行。此版使用 PyInstaller onedir，包含 Python 运行时，不是纯原生 C++ 组件。用户不需要安装 Python、Paddle 或启动 HTTP 服务。

开发构建要求 Windows x64、Python 3.12；建议在独立虚拟环境安装依赖：

```powershell
py -3.12 -m venv .tmp/ocr-venv
.tmp/ocr-venv/Scripts/python.exe -m pip install -r scripts/ocr/requirements.txt
$env:INVOICE_OCR_PYTHON = (Resolve-Path .tmp/ocr-venv/Scripts/python.exe).Path
npm run build:ocr
npm run dist:win
npm run test:packaged
```

构建脚本按固定 URL 下载模型并校验 SHA-256；安装后的应用不会下载模型。运行时存放 `.tmp/ocr-runtime/`，通过 electron-builder 的 extraResources 打入 `resources/ocr/`。后续打包会校验源码指纹和全部运行时文件哈希；源码改变或缓存缺失时须重新提供构建环境。不要将测试票据或本机 OCR 配置复制到此目录。

主进程通过标准输入/输出逐行 JSON 调用唯一子进程，不开放端口。启动时预加载模型并发送 ready；首次识别才启动，批量任务串行处理。识别超时或进程异常时结束子进程，下次手动重试可重新启动。临时图片位于应用数据目录 `ocr-temp/request-*`，请求结束后删除。异常关闭留下的临时图片在下次启动时清理。

新安装默认内置识别。已有外部服务设置保留，用户可在设置的“识别方式”切换。外部服务的协议、适配器与自动启动参数不影响内置引擎。

本机环境隔离测试不能替代干净 Windows 虚拟机验证。模型目前用一张已确认票据及其五种变体回归，不代表通用发票准确率。
