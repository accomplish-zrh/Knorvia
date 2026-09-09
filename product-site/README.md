# Knorvia 产品网站

全新产品站，2026-09-09。石墨底色、银钛和青玉材质、真实工作台画面。
Taste 参数为设计 9 / 动效 9 / 密度 4。网站的信息结构、排版和交互均已重建。

## 运行与构建

静态 HTML / CSS / JavaScript。安装当前目录依赖后运行 `npm run preview`，
打开 `http://127.0.0.1:4490`。发布时不需要 Node 服务。

`scripts/build.cjs` 从内容数据生成 `index.html`，并复制版本锁定的 Three.js
运行时。构建使用相邻 `web/node_modules` 中已安装的 React / Lucide；这些
依赖仅在构建时渲染图标，不传送 React 到访问者浏览器。运行 `npm run build`。
`npm run check` 使用已安装的 Chrome 做真实浏览器验收。可用 `CHROME_BIN`
指定 Chrome，用 `SITE_URL` 指定验收地址。

## 交互与降级

- `sculpture.js`：原创参数化立体折带，呼应当前 Knorvia 标识；真实环境反射、
  曲面高光、指针惯性、鼠标拖动、三种材质和暂停控制。暂停、离屏或后台停止绘制。
- `app.js`：五个产品画面的固定视口章节，滚动驱动左右进入、覆盖与释放。
  页签支持键盘，提供跳过入口。小屏与减少动态效果模式使用普通页签。
- `creation-scene.js`：按需加载的建筑光照示意，晨光 / 雨后 / 夜色联动提示词。
  不是模型生成作品；不发出模型请求。离屏停止绘制，静止后停止绘制。
- 图像放大使用原生 dialog；FAQ 支持展开收起动画；无脚本仍可阅读所有产品画面。
- WebGL 或模块加载失败时保留品牌图和 CSS 场景，正文与下载入口不依赖 3D。
- 一个主题、统一圆角规则、自托管字体；减少动态效果、减少透明效果和强制颜色降级。

## 内容与来源

产品截图来自真实生产前端连接原生内核，使用专门创建的本地演示资料。
没有修改截图中的页面结构，也没有调用收费模型。当前截图展示开发版，
公开下载的功能以发行说明为准。截图来源记录留在本地验收目录。

品牌来自项目当前图标。图标为 Lucide；字体为 Geist 400 / 600，中文系统字体。
GSAP / ScrollTrigger 3.13.0 和 Three.js 0.160.0 自托管，保留原始许可证。
参考 ThreeUI 的 Sylva 对材质、前后遮挡、视差和层次的处理方式，以及其
Community 组件的呈现方式。没有复制 Pro 组件代码、付费资源或参考站图片。

- https://threeui.com/hero/sylva/living-green
- https://threeui.com/three-js/structure-flow/structure-flow
- https://github.com/MengTo/threeui
- https://threejs.org/manual/en/fundamentals.html
- https://gsap.com/docs/v3/Plugins/ScrollTrigger/

## 发布

产品站为 `https://knorvia.xyz`。发布包只含明确列入清单的静态文件。
脚本、依赖目录、测试数据、原站快照和工作日志不发布。
静态资源按版本放在 `/r/<release>/`，新旧资源隔离，最后原子替换首页。
机器人与站点地图位于网站根目录。回退只需恢复上一个首页。

本轮网站的公开安装包仍指向已发布的 v1.0.0，未将开发版安装包伪装为公开稳定版。
