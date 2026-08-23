"""Self-contained editorial diagrams for the v3 welcome atlas."""

from __future__ import annotations


def _svg(inner: str, *, view: str, w: str = "100%", h: str = "auto") -> str:
    return f'<svg class="illu" viewBox="{view}" width="{w}" height="{h}" role="img" focusable="false">{inner}</svg>'


def brand_mark() -> str:
    return _svg(
        """<title>Knorvia</title><path d="M8 5h25l7 7v25H8z" fill="var(--solid)"/><path d="M33 5v8h7" fill="none" stroke="var(--aqua)" stroke-width="2"/><path d="M15 28V14m0 8 11-8m-11 8 12 7" fill="none" stroke="var(--paper)" stroke-width="3"/><circle cx="34" cy="31" r="3" fill="var(--coral)"/>""",
        view="0 0 48 44",
        w="40",
        h="40",
    )


def desk_scene() -> str:
    return _svg(
        """
    <title>Knorvia 工作台剖面：对话、工具、资料库与知识库</title><defs><linearGradient id="dw" x2="1" y2="1"><stop stop-color="var(--aqua-pale)"/><stop offset="1" stop-color="var(--paper-2)"/></linearGradient><pattern id="dg" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0v24" fill="none" stroke="var(--ink)" stroke-opacity=".055"/></pattern><filter id="ds"><feDropShadow dy="9" stdDeviation="7" flood-opacity=".18"/></filter></defs>
    <rect width="920" height="470" fill="url(#dw)"/><rect width="920" height="470" fill="url(#dg)"/><path d="M0 338h920v132H0z" fill="var(--solid)"/><path d="M0 338h920" stroke="var(--aqua)" stroke-width="3"/>
    <g opacity=".55"><path d="M70 48h154v146H70zM84 62h126v118H84z" fill="none" stroke="var(--ink)"/><path d="M147 62v118M84 121h126" stroke="var(--ink)" opacity=".35"/><circle cx="181" cy="87" r="16" fill="var(--sun)"/></g>
    <g transform="translate(250 52)"><path d="M0 248h420M24 248v90M394 248v90" stroke="var(--ink)" stroke-width="7"/><path d="M298 0h62l-15 50h-34z" fill="var(--coral)"/><path d="M329 50v73l-56 38" fill="none" stroke="var(--ink)" stroke-width="6"/><circle cx="271" cy="162" r="10" fill="var(--sun)"/>
    <g class="zone zone-chat" filter="url(#ds)"><path d="M70 113h204v126H70z" fill="var(--paper)" stroke="var(--ink)" stroke-width="2"/><path d="M82 127h180v16H82z" fill="var(--solid)"/><circle cx="94" cy="135" r="3" fill="var(--coral)"/><circle cx="105" cy="135" r="3" fill="var(--sun)"/><path d="M94 164h99M94 180h146M94 196h120" stroke="var(--ink)" opacity=".22" stroke-width="7"/><path d="m216 217 36-24-8 38z" fill="var(--aqua)"/></g>
    <g class="zone zone-tools" transform="translate(292 176)"><path d="M0 0h104v64H0z" fill="var(--blue)"/><path d="M17 16h40M17 31h70M17 46h52" stroke="var(--paper)" stroke-width="5"/><circle cx="88" cy="16" r="8" fill="var(--sun)"/></g></g>
    <g class="zone zone-drawer" transform="translate(60 278)" filter="url(#ds)"><path d="M0 0h170v130H0z" fill="var(--coral)"/><path d="M14 15h142v42H14zM14 72h142v42H14z" fill="var(--paper)" opacity=".2" stroke="var(--paper)"/><path d="M68 35h34M68 92h34" stroke="var(--paper)" stroke-width="4"/><text x="85" y="151" text-anchor="middle" fill="var(--paper)" font-size="12">LIBRARY / 抽屉</text></g>
    <g class="zone zone-shelf" transform="translate(700 78)" filter="url(#ds)"><path d="M0 0h160v274H0z" fill="var(--solid)"/><path d="M18 20v216M18 236h124" stroke="var(--paper)" opacity=".35"/><path d="M30 51h20v168H30z" fill="var(--aqua)"/><path d="M56 83h26v136H56z" fill="var(--sun)"/><path d="M88 35h22v184H88z" fill="var(--blue)"/><path d="m116 62 20 2-13 156-20-2z" fill="var(--coral)"/><text x="80" y="257" text-anchor="middle" fill="var(--paper)" font-size="11">KNOWLEDGE</text></g>
    <g fill="var(--paper)" font-size="11" font-family="monospace"><text x="32" y="452">LOCAL WORKSPACE / 01</text><text x="695" y="452">MODEL CONNECTS OUTSIDE ↗</text></g>""",
        view="0 0 920 470",
    )


def cast_scene() -> str:
    return _svg(
        """<title>你、Knorvia 和外部语言模型</title><defs><pattern id="cd" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="var(--ink)" opacity=".13"/></pattern><marker id="ca" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0l8 4-8 4z" fill="var(--aqua)"/></marker></defs><rect width="920" height="360" fill="var(--paper-2)"/><rect width="920" height="360" fill="url(#cd)"/><path d="M188 178H390M530 178h202" stroke="var(--aqua)" stroke-width="3" stroke-dasharray="7 7" marker-end="url(#ca)"/>
    <g transform="translate(108 90)"><circle cx="70" cy="70" r="67" fill="var(--coral)"/><path d="M40 93c8-25 52-25 60 0v42H40z" fill="var(--solid)"/><circle cx="70" cy="51" r="25" fill="var(--paper)"/><text x="70" y="174" text-anchor="middle" fill="var(--ink)" font-size="13" font-weight="700">YOU / 发起者</text></g>
    <g transform="translate(390 72)"><path d="M0 24h140v172H0z" fill="var(--solid)"/><path d="M14 38h112v80H14z" fill="var(--aqua-pale)"/><path d="M28 61h48M28 79h78M28 97h61" stroke="var(--ink)" opacity=".28" stroke-width="6"/><circle cx="34" cy="163" r="8" fill="var(--aqua)"/><circle cx="58" cy="163" r="8" fill="var(--sun)"/><text x="70" y="220" text-anchor="middle" fill="var(--ink)" font-size="13" font-weight="700">KNORVIA / 编排台</text></g>
    <g transform="translate(704 80)"><path d="M20 0h112l20 20v142l-20 20H20L0 162V20z" fill="var(--blue)"/><path d="M40 57c0-26 19-41 36-41s36 15 36 41c17 0 27 14 27 29 0 23-18 37-40 37H53c-23 0-40-15-40-37 0-16 11-29 27-29z" fill="none" stroke="var(--paper)" stroke-width="4"/><path d="M76 16v107M39 63h74M52 39l48 48M100 39 52 87" stroke="var(--paper)" opacity=".5"/><text x="76" y="206" text-anchor="middle" fill="var(--ink)" font-size="13" font-weight="700">MODEL / 外请大脑</text></g>""",
        view="0 0 920 360",
    )


def comic_strip() -> str:
    return _svg(
        """<title>第一次使用：接线、试音、开工</title><rect width="920" height="330" fill="var(--solid)"/>
    <g transform="translate(24 24)"><path d="M0 0h270v236H0z" fill="var(--aqua-pale)"/><text x="18" y="28" fill="var(--ink)" font-size="11" font-family="monospace">ACT 01 / 接线</text><path d="M50 120c35-60 72 60 112 0s70 25 74-30" fill="none" stroke="var(--coral)" stroke-width="8"/><circle cx="50" cy="120" r="18" fill="var(--paper)" stroke="var(--ink)" stroke-width="3"/><circle cx="236" cy="90" r="18" fill="var(--sun)" stroke="var(--ink)" stroke-width="3"/><text x="18" y="215" fill="var(--ink)" font-size="14" font-weight="700">把三项配置放对位置</text></g>
    <g transform="translate(325 24)"><path d="M0 0h270v236H0z" fill="var(--paper)"/><text x="18" y="28" fill="var(--ink)" font-size="11" font-family="monospace">ACT 02 / 试音</text><path d="M38 62h194v105H38z" fill="var(--blue)"/><path d="m68 167-20 22 45-22" fill="var(--blue)"/><text x="135" y="130" text-anchor="middle" fill="var(--paper)" font-size="54" font-family="serif">好</text><text x="18" y="215" fill="var(--ink)" font-size="14" font-weight="700">确认线路能回一个字</text></g>
    <g transform="translate(626 24)"><path d="M0 0h270v236H0z" fill="var(--coral)"/><text x="18" y="28" fill="var(--ink)" font-size="11" font-family="monospace">ACT 03 / 开工</text><path d="M34 58h82v112H34z" fill="var(--paper)"/><path d="M129 58h107v52H129zM129 118h107v52H129z" fill="var(--solid)"/><path d="M49 79h51M49 96h37M49 113h51" stroke="var(--ink)" opacity=".3" stroke-width="5"/><text x="18" y="215" fill="var(--ink)" font-size="14" font-weight="700">交给它一件具体的事</text></g><text x="24" y="309" fill="var(--paper)" font-size="10" font-family="monospace" letter-spacing="2">FIRST SIGNAL / THREE SMALL MOVES</text>""",
        view="0 0 920 330",
    )


def five_roles() -> str:
    data = (
        ("TOOL", "工具", "M18 75h68M52 41v68"),
        ("CAPABILITY", "能力", "M18 97 52 37l34 60z"),
        ("CHAT", "对话", "M17 45h70v48H45l-18 17 5-17H17z"),
        ("LIBRARY", "资料库", "M19 47h66v58H19zM31 61h42M31 76h28"),
        ("KNOWLEDGE", "知识库", "M23 38h18v67H23zM45 49h18v56H45zM67 42h18v63H67z"),
    )
    colors = ("var(--coral)", "var(--blue)", "var(--sun)", "var(--aqua)", "var(--plum)")
    cards = []
    for i, (en, zh, path) in enumerate(data):
        cards.append(
            f'<g transform="translate({18 + i * 180} 34)"><path d="M0 0h164v206H0z" fill="{colors[i]}"/><text x="16" y="24" fill="var(--ink)" font-size="9" font-family="monospace">0{i + 1} / {en}</text><g transform="translate(31 42)"><circle cx="52" cy="75" r="50" fill="var(--paper)" opacity=".75"/><path d="{path}" fill="none" stroke="var(--ink)" stroke-width="4"/></g><text x="82" y="181" text-anchor="middle" fill="var(--ink)" font-size="18" font-weight="700">{zh}</text></g>'
        )
    return _svg(
        '<title>五类对象图鉴</title><rect width="920" height="274" fill="var(--paper-2)"/>'
        + "".join(cards),
        view="0 0 920 274",
    )


def journey_scene() -> str:
    return _svg(
        """<title>API 请求线路图</title><defs><marker id="ja" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0l9 4.5L0 9z" fill="var(--aqua)"/></marker></defs><rect width="920" height="270" fill="var(--solid)"/><path d="M70 137H850" stroke="var(--aqua)" stroke-width="3" marker-end="url(#ja)"/><path d="M850 174H70" stroke="var(--coral)" stroke-width="2" stroke-dasharray="7 8" marker-end="url(#ja)"/>
    <g class="jp jp-you" transform="translate(40 88)"><circle cx="30" cy="30" r="28" fill="var(--coral)"/><circle cx="30" cy="24" r="9" fill="var(--paper)"/><text x="30" y="112" text-anchor="middle" fill="var(--paper)" font-size="11">你</text></g><g class="jp jp-desk" transform="translate(185 88)"><path d="M0 0h74v60H0z" fill="var(--paper)"/><path d="M12 13h50v27H12z" fill="var(--blue)"/><text x="37" y="112" text-anchor="middle" fill="var(--paper)" font-size="11">Knorvia</text></g>
    <g class="jp jp-post" transform="translate(340 78)"><path d="m0 34 44-31 44 31v60H0z" fill="var(--blue)"/><path d="M16 45h56M25 45v35M44 45v35M63 45v35" stroke="var(--paper)" stroke-width="4"/><text x="44" y="122" text-anchor="middle" fill="var(--paper)" font-size="11">BASE URL</text></g><g class="jp jp-clerk" transform="translate(505 88)"><circle cx="37" cy="28" r="28" fill="var(--plum)"/><path d="M10 63h54v29H10z" fill="var(--paper)"/><text x="37" y="82" text-anchor="middle" fill="var(--ink)" font-size="10">MODEL</text></g><g class="jp jp-key" transform="translate(670 92)"><circle cx="25" cy="25" r="19" fill="none" stroke="var(--sun)" stroke-width="9"/><path d="M42 39l40 40m-15-15 10-10" stroke="var(--sun)" stroke-width="9"/><text x="45" y="108" text-anchor="middle" fill="var(--paper)" font-size="11">API KEY</text></g><g class="jp jp-back" transform="translate(813 91)"><path d="M0 0h68v54H0z" fill="var(--paper)"/><path d="m0 0 34 28L68 0" fill="none" stroke="var(--coral)" stroke-width="4"/><text x="34" y="105" text-anchor="middle" fill="var(--paper)" font-size="11">回信</text></g><text x="48" y="31" fill="var(--paper)" font-size="10" font-family="monospace" letter-spacing="2">REQUEST ROUTE / OUTBOUND</text>""",
        view="0 0 920 270",
    )


def jars() -> str:
    panels = (
        ("01 / CREDENTIAL", "钥匙不是截图素材", "var(--blue)", "KEY"),
        ("02 / BILLING", "每次调用都会记账", "var(--sun)", "¥"),
        ("03 / PAYLOAD", "发送前先检查内容", "var(--coral)", "!"),
    )
    out = [
        '<title>安全三联图：密钥、费用与数据</title><rect width="920" height="330" fill="var(--solid)"/>'
    ]
    for i, (top, bottom, color, glyph) in enumerate(panels):
        out.append(
            f'<g transform="translate({52 + i * 286} 44)"><path d="M0 0h244v224H0z" fill="{color}"/><text x="20" y="30" fill="var(--ink)" font-size="10" font-family="monospace">{top}</text><circle cx="122" cy="112" r="58" fill="var(--paper)" opacity=".86"/><text x="122" y="136" text-anchor="middle" fill="var(--ink)" font-size="68" font-weight="800">{glyph}</text><text x="20" y="205" fill="var(--ink)" font-size="20" font-weight="700">{bottom}</text></g>'
        )
    return _svg("".join(out), view="0 0 920 330")


def house_map() -> str:
    return _svg(
        """<title>Knorvia 工作区平面索引</title><rect width="920" height="480" fill="var(--paper-2)"/><path d="M70 60h780v340H70z" fill="none" stroke="var(--ink)" stroke-width="4"/><path d="M350 60v340M350 250h500M650 60v340" stroke="var(--ink)" stroke-width="3"/><path d="M70 60h280v340H70z" fill="var(--blue)"/><path d="M350 60h300v190H350z" fill="var(--coral)"/><path d="M650 60h200v190H650z" fill="var(--aqua)"/><path d="M350 250h300v150H350z" fill="var(--sun)"/><path d="M650 250h200v150H650z" fill="var(--plum)"/><g fill="var(--ink)"><text x="105" y="105" font-size="11" font-family="monospace">ROOM 01 / START HERE</text><text x="105" y="205" font-size="38" font-family="serif">对话厅</text><text x="380" y="102" font-size="11" font-family="monospace">ROOM 02</text><text x="380" y="166" font-size="28" font-family="serif">设置 / 接线间</text><text x="680" y="102" font-size="11" font-family="monospace">ROOM 03</text><text x="680" y="166" font-size="28" font-family="serif">知识库</text><text x="380" y="292" font-size="11" font-family="monospace">ROOM 04</text><text x="380" y="352" font-size="28" font-family="serif">图像与视频工作室</text><text x="680" y="292" font-size="11" font-family="monospace">YOU ARE HERE</text><text x="680" y="352" font-size="28" font-family="serif">资料库</text></g>""",
        view="0 0 920 480",
    )


def terrarium() -> str:
    return _svg(
        """<title>隔离预览边界示意图</title><rect width="920" height="330" fill="var(--paper-2)"/><path d="M176 38h568v238H176z" fill="var(--paper)" stroke="var(--blue)" stroke-width="5" stroke-dasharray="12 7"/><path d="M203 68h514v178H203z" fill="var(--solid)"/><path d="M242 101h230v115H242z" fill="var(--aqua-pale)"/><path d="M260 121h194v14H260z" fill="var(--blue)"/><path d="M260 153h123M260 174h166M260 195h91" stroke="var(--ink)" opacity=".3" stroke-width="7"/><path d="M516 103h160v111H516z" fill="var(--coral)"/><path d="M545 130h102M545 153h78" stroke="var(--ink)" stroke-width="8"/><g fill="var(--muted)" font-size="10" font-family="monospace"><text x="176" y="23">SANDBOX BOUNDARY / ORIGIN: NULL</text><text x="27" y="108">NO NETWORK</text><text x="27" y="132">NO PARENT ACCESS</text><text x="27" y="156">NO CREDENTIALS</text><text x="759" y="108">INLINE ONLY</text><text x="759" y="132">CSP LOCKED</text><text x="759" y="156">LOCAL VIEW</text></g><text x="460" y="309" text-anchor="middle" fill="var(--ink)" font-size="12" font-weight="700">VISIBLE · INTERACTIVE · ISOLATED</text>""",
        view="0 0 920 330",
    )
