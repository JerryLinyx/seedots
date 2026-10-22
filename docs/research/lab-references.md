# Lab 外部调研：WeduLab 与交互学习

日期：2026-10-20 至 2026-10-22。状态：调研结论，供设计参考，不代表已实现。我们自己的设计和取舍见 [`../decisions/lab-decisions.md`](../decisions/lab-decisions.md)。

本文合并了三份过程文档：WeduLab 拆解、交互学习流程调研中的案例与学习科学部分。

## 1. WeduLab 拆解

对象：<https://wedulab.com/>，33 个手工制作的交互实验室，免费、免登录，支持 7 种语言。

**方法与边界**
- 做了什么：
  - 从主包的路由表和依赖表还原全部实验室，下载 63 个 JS 块（约 5.2 MB）做静态阅读；
  - 用 REA 对 FuncLab 做静态图分析；
  - 在浏览器里打开了 10 个实验室，读章节和画面。
- 没做什么：没有执行它的代码，也没有逐章实际操作。“实现”一栏里标“推断”的都是推断。
- 版权：它没有声明开源协议。我们只借鉴模式，**不复制它的代码、文案、美术和名称**。

### 1.1 总体

| 项 | 观察 |
| --- | --- |
| 规模 | 6 个学科、33 个实验室，约 300 个章节或实验；作者署名 WY，像个人作品 |
| 是否生成式 | 否。没有模型调用，后端只有埋点和反馈两个接口 |
| 技术 | 外壳是 React + Vite，每个实验室按路由懒加载（25–350 KB）；内部是原生 JS + three.js 直接操作 DOM 和 WebGL |
| 课堂特性 | 投影模式、键盘快捷键、章节深链接、Paper / Studio 两套主题；文案源语言中文，`t()` 包裹翻译 |

### 1.2 实验室清单（按共用工具包分成 6 个家族）

| 家族 | 实验室与主题 | 共用工具包 / 关键技巧 |
| --- | --- | --- |
| A. 数学作图 | FuncLab（图像变换、单位圆、割线到切线、二分法、黎曼和）、ConicLab、GeoSpace（截面、展开图、三视图）、ConstructLab（尺规作图，按步数评星）、PythagoLab、WonderLab（分形、黄金比） | 统一生命周期模块（§1.3）+ 小型 2D 作图 API；描边、庆祝动画 |
| B. 物理实验台 | MotionLab（纸带、光电门、牛二、摩擦、碰撞）、OpticsLab（反射折射、透镜成像、干涉衍射）、WaveLab（简谐、共振、驻波、多普勒，WebAudio）、FieldLab（电场线、洛伦兹力、电磁感应） | 声明式章节配置（§1.3）；SVG 图表坞（记录、拟合）；程序化纹理、七段数码管 |
| C. 真实场景器材 | MachineLab（杠杆、滑轮）、FloatLab（浮力、吃水）、GasLab（制氧，做错会炸管或倒吸）、AnalytLab（滴定、离子检验）、MicroLab（显微镜，按真实光学渲染视野） | 器材零件库；玻璃器皿、液体、气泡、火焰 |
| D. 生物分子舞台 | Cell 3D、PeaLab（孟德尔杂交 + 卡方检验）、ATPLab、DNALab（调参数让衍射图对上 Photo 51）、ImmuneLab（去掉辅助 T 细胞看后果） | 电影感后处理（景深、暗角、颗粒、辉光、GTAO，自动降级）；真实结构数据（PubChem、PDB） |
| E. 地球与地形 | Contour（3D 地形 ↔ 等高线 ↔ 剖面联动）、Atmos-Flow（理想模型 vs NCEP 再分析数据）、Earth-Motion（四季、昼长）、Land & Sea（板块漂移）、WaterCycle | OrbitControls、地球贴图、投影工具包 |
| F. 叙事时间轴 | WarTable（9 场战役，真实高程上的兵力行军 + 字幕旁白）、HistoryAtlas（16 个年份的疆域变迁） | 字幕与镜头特效、DEM 地形 |

另有两个沙盒型：VoltLab（自写电路求解器，MNA + 牛顿法，3D 实物台 + 原理图 + 示波器）、PeriodicLab（周期表数据可视化，多种形态插值）。

### 1.3 三种章节契约（对我们最有用）

| 契约 | 谁在用 | 形式 |
| --- | --- | --- |
| 生命周期模块 | 数学家族 | 每章是一个工厂函数，运行时只调用可选方法：`enter / leave / reset / panel / info / frame / draw / input / action / pointer`。控件只带 `data-param` / `data-act`，由运行时统一分发 |
| 声明式配置 | 物理实验台家族 | 章节是纯数据：`rig`、`params`、`controls`（只露出本章相关的控件）、`readouts`、`tabs`（数据坞视图）、`record`、`cam`、`steps`、`quiz`、`cite`。参数类型在注册表里统一定义：`range` / `toggle` / `seg` |
| 场景 API + 事件任务 | PeaLab、PeriodicLab | 章节带脚本：`setup(e)` 调用领域动词（`sow / day / harvest …`）布置场景；`tasks` 在场景发出对应事件时打勾；`acts` 是老师演示用的一键按钮 |

### 1.4 交互模式（17 种）

1. 滑块调参、实时重绘；2. 选项切换；3. 直接拖动画面里的物体；4. 播放 / 单步 / 时间轴；5. “开始实验”运行物理过程；6. 记录数据 → 表格 → 拟合；7. 实时仪表；8. 多视图联动；9. 规范操作流程，做错有后果；10. 去掉一个因素看后果；11. 让模型和真实数据对齐；12. 构造并评分；13. 统计检验；14. 事件驱动任务清单 + 演示按钮；15. 章末选择题；16. 沙盒章节；17. 叙事播放 + 字幕。

### 1.5 教学与视觉做法

- 每章 = 讲解 + 操作 + 观察 + 量化。先做实验、记录数据，再从拟合得出规律。
- 控制变量是显式设计：每章只露出少数控件。
- 引用科学史出处，使用真实数据。
- **没有“先预测再验证”，也没有开放式解释**；测验放在最后，形式是 4 选 1。
- 学完引导章节后给一个全参数开放的沙盒。
- 后处理加程序化纹理，几乎不依赖美术素材。
- 每章指定镜头，切章时飞行过渡。
- 性能上：大量对象用 InstancedMesh，像素比上限 2。

### 1.6 和 SeeDots 的根本差别

| | WeduLab | SeeDots |
| --- | --- | --- |
| 内容来源 | 作者手工制作 | 按视频章节自动生成 |
| 覆盖 | 33 个固定主题，以中学理科为主 | 任意视频 |
| 教学闭环 | 讲解 → 操作 → 测验 | 预测 → 操作 → 对比 → 解释（Coach 检查） |
| 证据 | 无 | 每个实验链接到视频证据 |

结论：不照搬它的实验室，而是借用它的**声明式配置、实验台分层和后处理技巧**，让模型能可靠地配置实验。WeduLab 单个实验室最多有 350 KB 手写代码；我们要的是少量通用实验台，而不是逐个主题手做。

## 2. 让学习不止于记忆：学习科学依据

| 依据 | 要点（证据强弱） | 对我们的含义 |
| --- | --- | --- |
| ICAP（Chi & Wylie 2014） | 投入从被动、主动、建构到互动依次加深，预期效果依次提高；**实证结果不一**，认知负荷过高时反而更差 | 让学习者产出东西（预测、解释、规律），但要控制难度 |
| 隐性脚手架（PhET） | 用控件选择和反馈引导，少用文字指令 | 只露出相关控件，靠即时反馈引导 |
| 预测、观察、解释（POE） | 先表态再验证，预期被打破时最容易学到东西 | 我们的主流程 |
| 有成效的失败（Kapur）、发明活动与对比案例（Schwartz） | 先尝试再讲解；对比案例帮助看清关键特征；概念理解和迁移更好 | 对比案例、自己写规律 |
| 生成性学习（Fiorella & Mayer 2015） | 自我解释、教别人等 8 种策略 | 解释交给 Coach 检查；“教给 AI 学生” |
| 被保护者效应（Chase 等 2009，Betty's Brain） | 以为在教虚拟学生时更投入，对基础弱的学生效果更明显 | Coach 扮演学生 |

## 3. 12 种活动方式与典型案例

| # | 活动 | 学习者做什么 | 典型案例 | 我们的状态 |
| --- | --- | --- | --- | --- |
| 1 | 预测→观察→解释 | 先选会怎样，再动手看，然后解释 | PhET；WeduLab | 已实现 |
| 2 | 让它发生 | 给定目标，自己找参数 | TensorFlow Playground | 已实现（任务） |
| 3 | 找边界 | 找出什么时候失效（如学习率多大会发散） | 梯度下降 | 部分（`sweep` 接口已有，活动未做） |
| 4 | 收集数据、发现规律 | 改一个量、测另一个量，记录后拟合 | MotionLab 的 a-F 图；单摆测 g | 已实现（数据坞） |
| 5 | 对比案例 | 只差一个因素的两套设置并排运行 | Schwartz；Seeing Theory | 未做 |
| 6 | 自己写规律 | 先猜一个公式，系统把它画在数据上 | 发明活动；Desmos | 未做（表达式语言可直接用） |
| 7 | 拿掉一个因素 | 关掉一个机制看后果 | ImmuneLab；*Parable of the Polygons* | 已实现（开关参数） |
| 8 | 找错 | 用实验台反驳一个看似合理的错误说法 | 误解诊断题 | 未做 |
| 9 | 教给 AI 学生 | AI 学生按学习者的解释去预测，错了让学习者修正 | Betty's Brain | 未做 |
| 10 | 先估算再测量 | 先给数值估计，再测出真实值 | 费米估算 | 未做（现在只有三选一） |
| 11 | 换情境迁移 | 同一个实验台换一个问题情境 | 变式练习 | 未做 |
| 12 | 系统与涌现 | 设定个体规则，观察整体 | *Evolution of Trust*、Loopy | 未做（需要智能体模拟实验台） |

**衡量“不只是记住”的候选证据**：
- 同一概念前后两次预测的正确率变化；
- 不用“Set …”按钮、独立完成任务；
- 解释是否提到关键机制；
- 换情境后第一次就做对；
- 数值估算的偏差。

是否计入掌握度待定（见决策记录第 4 节）。

## 参考

- PhET 隐性脚手架：[arXiv 1306.6544](https://arxiv.org/pdf/1306.6544)；[RSC CERP 2013](https://pubs.rsc.org/en/content/articlehtml/2013/rp/c3rp20157k)
- ICAP：[Chi & Wylie 2014](https://chilab.asu.edu/sites/default/files/lcl/chiwylie2014icap_2.pdf)；相反的结果：[UGA OpenScholar](https://openscholar.uga.edu/record/27487)
- 有成效的失败：[BU CTL](https://www.bu.edu/ctl/?p=5396)；[CU Boulder SEI](https://colorado.edu/sei/content/making-failure-more-productive-scaffolding-invention)；[Kapur, Saba & Roll 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10185511)
- 生成性学习：[Fiorella & Mayer 2015](https://www.lavoisier.fr/livre/autre/learning-as-a-generative-activity/fiorella/descriptif_3081373)
- 被保护者效应：[Chase, Chin, Oppezzo & Schwartz](https://purl.stanford.edu/zm369yx3532)
- 可探索的解释：[Bret Victor](https://worrydream.com/ExplorableExplanations/)；[awesome-explorables](https://github.com/blob42/awesome-explorables)
- 机器学习交互：[TensorFlow Playground（arXiv 1708.03788）](https://arxiv.org/abs/1708.03788)；[Hugging Face：交互工具](https://huggingface.co/blog/Suzana/interactive-tools)
