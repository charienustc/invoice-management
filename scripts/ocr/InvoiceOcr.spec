from PyInstaller.utils.hooks import collect_data_files
from pathlib import Path
import os

source = Path(SPECPATH)
model_root = Path(os.environ['INVOICE_OCR_MODELS'])
datas = collect_data_files('rapidocr', excludes=['models/**']) + [(str(model_root), 'models')]
a = Analysis([str(source / 'worker.py')], pathex=[], binaries=[], datas=datas,
    hiddenimports=[], hookspath=[], hooksconfig={}, runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'torch', 'paddle', 'pypdfium2', 'psutil'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='InvoiceOcr', debug=False,
    bootloader_ignore_signals=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='InvoiceOcr')
