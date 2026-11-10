# 发票管理

Windows 本地发票与垫付款管理工具。支持项目归集、PDF/图片预览、发票校对、标签筛选、统计导出、报销材料包及数据备份。

安装包内置 PP-OCRv6 small 模型，通过 RapidOCR 与 ONNX Runtime 在本机识别；使用者无需另装 Python 或 OCR 服务。识别结果需要人工核对。应用不集成大语言模型。

可选 MCP 服务供支持标准 MCP 协议的外部 agent 调用，默认关闭、默认只读，只监听本机并校验令牌。连接方式见 [MCP 文档](docs/mcp.md)。

## 开发

支持 Windows x64。使用 Node.js 24.15 或以上的 24.x LTS、npm，以及 Python 3.12（构建 OCR 时需要）。Node 22 最低要求 22.22.2。从源码开始：

```powershell
npm ci
py -3.12 -m venv .tmp/ocr-venv
.tmp/ocr-venv/Scripts/python.exe -m pip install -r scripts/ocr/requirements.txt
$env:INVOICE_OCR_PYTHON = (Resolve-Path .tmp/ocr-venv/Scripts/python.exe).Path
npm run build:ocr
npm run dev
```

首次构建需要联网下载 npm/Python 依赖和 OCR 模型；模型按固定 SHA-256 校验。安装后的内置识别不下载模型。[OCR 构建细节](scripts/ocr/README.md)。

## 检查与打包

```powershell
npm run verify:release -- --source-only
npm audit --registry=https://registry.npmjs.org
npm run typecheck
npm test
npm run test:e2e
npm run dist:win
npm run test:packaged
```

安装包位于 `artifacts/<版本>/`。打包前检查源码隐私规则和依赖许可证，构建 OCR 时校验模型、运行时哈希和许可证。打包验证会在独立临时数据目录中启动应用，执行内置 OCR 和主要业务流程。首次公开发布仍建议在干净 Windows 虚拟机中安装、卸载并验证。

云端 Windows 测试机额外安装固定版本的 Noto Sans CJK SC 与 Noto Serif CJK SC，并验证 SHA-256，分别支持合成 OCR 图片及没有嵌入宋体类字体的 PDF。字体仅安装在临时运行器中，不进入源码仓库或安装包。

业务数据与设置目录及迁移规则见 [数据存储说明](docs/storage.md)。不要提交数据库、票据、备份、真实 MCP 令牌、签名证书或本机工具记录；`.gitignore` 与发布检查只能降低误提交风险，首次提交前仍需审查文件清单。

## 许可证

项目源码采用 [MIT](LICENSE)。第三方组件和模型保留各自许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
