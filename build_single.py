# -*- coding: utf-8 -*-
"""把 index.html + data.js + app.js 合成一个自包含的单文件页面（手机可直接打开）"""
import io, re, os

D = r"E:\Software Development\Software Development\longmao-farm-calculator"
OUT = os.path.join(D, "龙猫收益计算器-单文件.html")

html = io.open(os.path.join(D, "index.html"), encoding="utf-8").read()
data = io.open(os.path.join(D, "data.js"), encoding="utf-8").read()
app = io.open(os.path.join(D, "app.js"), encoding="utf-8").read()

# 去掉外链 script，改成内联
html = html.replace('<script src="data.js"></script>', "").replace('<script src="app.js"></script>', "")
inline = "<script>\n" + data + "\n" + app + "\n</script>\n"
html = html.replace("</body>", inline + "</body>")

io.open(OUT, "w", encoding="utf-8", newline="\n").write(html)
print("written", OUT, os.path.getsize(OUT), "bytes")
