# TeamAI

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **中文** · [Español](README.es.md)

TeamAI 是面向 **Claude Code** 和官方 **Codex CLI** 的本地多账号中继。它为每个服务商维护独立的账号池，当所选订阅账号不可用或配额耗尽时，会自动换一个账号重试请求。

![TeamAI 仪表盘](docs/dashboard.png)

<sub>上方的仪表盘是用 <code>teamai capture --redact full</code> 得到的真实截取：真实的配额与活动日志，没有账号地址。</sub>

> TeamAI 是一个独立的开源项目，与 Anthropic、OpenAI 以及与之无关的 teamai.com 服务均无任何关联。

## 环境要求

- Node.js 20 及以上
- macOS 或 Linux
- 单独安装的 `claude` 和／或 `codex`
- 你自己的 Claude Pro/Max 或 ChatGPT Codex 订阅账号

## 安装

```bash
git clone https://github.com/soulduse/team-ai.git
cd team-ai
./scripts/install.sh
```

`install.sh` 会安装依赖、执行构建、链接 `teamai`/`tai`/`tac`/`tax` 命令，并询问是否添加 shell 配置块。该脚本是幂等的——升级时重新执行即可。加 `--no-shell` 可跳过 shell 配置块，加 `--dry-run` 则只显示将要执行的操作。

如果想手动完成同样的步骤：

```bash
npm install
npm run build          # 必需：dist/ 未提交到仓库
npm link
```

打算用 AI 智能体来自动化安装？请参阅 [AGENTS.md](AGENTS.md)，其中把相同的步骤写成了带校验环节与失败分支的确定性命令。

## 快速开始

```bash
teamai login
tai
```

`login` 会询问要添加 `[1] Claude` 还是 `[2] Codex`。要添加更多账号，重复执行即可。`tai` 是简写的会话命令，等价于 `teamai start`：启动本地中继并打开仪表盘。在 TUI 中按 `1` 启动 Claude Code，按 `2` 启动 Codex。客户端退出后会回到仪表盘。

若想直接开启某个服务商的会话，请使用专用启动命令。它们会在必要时自动拉起 TeamAI 中继，并把后面跟的所有参数原样传给官方客户端：

```bash
tac                   # 经由 TeamAI 账号池的 Claude Code
tac --resume          # 等同于：teamai claude --resume
tax                   # 经由 TeamAI 账号池的 Codex
tax resume            # 等同于：teamai codex resume
teamai claude         # tac 的完整写法
teamai codex          # tax 的完整写法
teamai session        # 交互式选择 [1] Claude 或 [2] Codex
```

这些名称是有意取的，以免覆盖已有的 TeamClaude `tc` shell 函数。`tc` 可以继续指向 TeamClaude，而 `tac` 和 `tax` 指向 TeamAI。

## Shell 配置

```bash
./scripts/install-shell.sh            # 向 ~/.zshrc 添加带标记的配置块
./scripts/install-shell.sh --dry-run  # 只显示差异，不写入文件
./scripts/install-shell.sh --uninstall
```

它会定义经由账号池的 `cl`（Claude Code）和 `co`（Codex），以及 `tai`、`tais` 和用于 LaunchAgent 的 `taistart`/`tairestart`/`taistop`，同时取消全局固定的 `ANTHROPIC_BASE_URL`——TeamAI 会让每个会话指向自己的端口，残留的全局值只会把流量导向一个可能早已停止运行的代理。该配置块由标记界定并就地重写，因此重新执行是更新而不是追加；每次写入都会留下带时间戳的备份，反复安装／卸载也能让文件逐字节还原。

守护进程是可选的：`cl`、`co`、`tai` 和 `teamai run` 在发现没有进程监听时都会自行启动中继，所以即使 LaunchAgent 被卸载、启动失败或从未安装过，它们依然能正常工作。进程被杀后残留的过期 `server.json` 会被忽略并替换掉。启动确实失败时，报告的是服务端给出的具体原因（端口已被占用、凭据文件无法读取等），而不是一句干巴巴的 "did not start"，完整输出则保留在 `~/.config/teamai/server-start.log`。

### 将中继作为登录项运行

这一步是可选的。上面安装的 `taistart`/`tairestart`/`taistop` 别名操作的是标签为 `com.teamai.proxy` 的 LaunchAgent，所以请严格使用该标签：

```xml
<!-- ~/Library/LaunchAgents/com.teamai.proxy.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>com.teamai.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/ABSOLUTE/PATH/TO/team-ai/dist/src/cli.js</string>
    <string>server</string>
  </array>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardErrorPath</key> <string>/tmp/teamai.err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.teamai.proxy.plist
```

Node 路径请用 `command -v node` 查到的真实路径填写；LaunchAgent 不会继承你 shell 的 PATH。

## 账号

Codex 沿用其常规的浏览器登录流程。TeamAI 并不要求开启 ChatGPT 中那个可选的设备码（device-code）认证设置。

导入凭据是可选的，且仅在存在可导出的凭据文件时才有效：

```bash
# 从已有的 TeamClaude 配置中导入全部账号。
teamai import claude --from ~/.config/teamclaude.json

# 导入 Codex CLI 当前基于文件的登录信息（如果存在）。
teamai import codex
```

较新版本的 Claude Code 可能把凭据存放在 macOS 钥匙串而不是 `~/.claude/.credentials.json` 中；这种情况下请改用 `teamai login`。`import` 绝不会修改原有的 TeamClaude、Claude Code 或 Codex 文件。TeamAI 为中继会话使用一个持久化的隔离 Codex 主目录，因此用户原本的 `~/.codex` 保持原样。

## 运维

```bash
teamai status                                  # 服务器状态 + 账号表
teamai accounts [claude|codex]                 # 仅账号表
teamai start                                   # 启动中继并打开仪表盘
teamai stop                                    # 停止中继
teamai restart                                 # 停止、重启并打开仪表盘
teamai server                                  # 在前台运行中继
teamai tui                                     # 仅仪表盘，不自动启动
teamai disable codex user@example.com
teamai enable codex user@example.com
teamai priority claude user@example.com 1      # 或者：auto
teamai capture [--redact partial|full|none] [--out DIR]   # 把仪表盘保存为 .txt 和 .png（无需 TTY）
```

账号按剩余配额多少排序，消耗最少的排在最前，仪表盘和账号池自身的选取逻辑用的是同一套顺序——所以最上面那一行就是下一个请求将要使用的账号。Claude 的判定依据是按模型计的周窗口（Fable），而不是总的那个，因为实际上最先拒绝顶级模型的正是这个窗口。一旦所有账号都耗尽，它们就全部并列，排序便退化为谁先恢复谁在前——在今天没有任何账号能处理请求的情况下，距离重置的时间是区分它们的唯一依据（Claude 看 Fable 窗口，Codex 看它的周窗口）。未经测量的账号排在最后（未知不等同于用尽），手动固定的优先级依然优先生效，按 `c` 可切换回配置的顺序。

**模型感知路由。** 只有顶级模型（Claude 的 Fable 档）才会动用按模型计的周窗口，因此并不需要它的请求——Opus、Sonnet、Haiku——会被从仍有 Fable 余量的账号上引开，转而分给那些 Fable 窗口已经用尽（达到或超过 `fableReserveThreshold`）的账号，并在这一组内按总的周窗口排序。这样就把每个账号稀缺的 Fable 余量留给真正需要它的请求，同时把原本闲置的周窗口余量利用起来。当没有已用尽的账号空闲时，请求会回退到一个被保留的账号，而不是直接失败。Fable 请求仍沿用普通的"消耗最少优先"顺序；把 `fableReserveThreshold` 设为 `1` 即可关闭这种拆分。

Fable 档的 429（`7d_oi` 被拒，而共享的 `5h`／`7d` 窗口仍为允许）只会把该账号的 Fable 窗口搁置，而不是整个账号：其余各模型仍会继续由它服务，而不至于让整个账号为了一份只有顶级模型才消耗的余量而空闲长达一周。若某个 429 拒绝的是共享窗口，则照常搁置整个账号。

全屏 TUI 会把 Claude 和 Codex 账号分组显示，并在用量变化时保持当前选中的账号位置不动。Claude 行分别独立显示 `5h session`、`7d overall` 以及按模型划分的 `7d Fable` 三个窗口；Codex 行显示其主、次两个窗口，每个窗口的标题取自该账号实际上报的时间跨度（`1w limit`）。配额是从官方客户端的响应中学习得来的，并会在重启后保留。

底栏提供与 TeamClaude 相同的账号操作流程：启动 Claude/Codex、选择、切换、启用／禁用、排序、删除、添加／登录、重新测量（`R`）以及退出。`switch` 会把选中的账号固定到其所属服务商账号池的最前面；排序模式下可以指定名次，也可以把某个账号交回自动调度。刷新 Claude 资料时会显示套餐等级，并以红色标出 `past_due` 这类异常的订阅状态。

`p` 会把仪表盘截取并保存，`teamai capture` 则可以在没有终端的情况下从脚本或代理完成同样的事。每次截取会在 `~/.config/teamai/captures/`（或 `--out DIR`）下留下一对文件：保留原有颜色的文本帧，以及用内置位图字体绘制的同一帧 PNG，除 Node 之外不需要任何东西。账号地址在绘制帧之前就已被遮盖，因此账号列、页脚和活动日志中都不会残留。默认是 `de•••••••••w@gm•••.com` 这样的部分遮盖；`--redact full` 会替换为 `account #N`；`--redact none` 则保留地址，用于只给自己看的截取。在仪表盘中按 `p`，除了保存之外，还会在文件管理器中定位到该 PNG，并把图片复制到剪贴板——macOS 上开箱即用，Linux 上需要安装 `xdg-open` 以及 `wl-copy` 或 `xclip`。页脚会说明哪些操作实际完成了。本 README 顶部的图片就是这样得到的一次截取。

`R` 会对整批账号重新测量配额。配额从来不是通过轮询某个单独的接口获取的——它是从上游返回的 rate-limit 响应头中学习来的，因此一个还没承载过任何流量的账号会一直显示 `-`，直到有什么东西去测量它。`R` 会把一个已知会被接受的请求形态并行重放到每个空闲账号上（包括已测量过的和已被限流的账号，后者的 429 响应同样带有权威的响应头），并如实报告 `measured/targets` 计数。这个请求形态只有在真正经代理成功返回 2xx 后才会被确定下来，所以在还没有一次成功请求之前，`R` 会告知尚不存在探测模板，而不是去猜测一个请求体。缺少按模型计的周窗口（Fable）的账号会额外收到一次补充探测，因为该窗口只会出现在 Fable 级别请求的响应里。

服务端自身也会每五分钟做一次预热（`warmupIntervalMs`，设为 0 可禁用）：它会清理上游已经重置的配额窗口，并只测量那些尚未测量的账号，因此在一个稳定的账号集群上每个周期几乎不产生任何开销，而窗口一旦轮转就会自动补满，无需任何人去按 `R`。如果某个账号的上游始终不上报配额，在三次徒劳的尝试之后它会被剔除；而每当该窗口重置或你按下 `R`，这份尝试预算就会重新发放。

空闲账号也会在这同一个五分钟周期里被保活：凡是令牌即将过期、或上一次尝试出错的账号，都会被逐个刷新。日常流量往往只集中在少数几个账号上，而预热又刻意从不刷新令牌，所以若没有这一步，一个无人使用的账号就可能让它的 refresh-token 链条失效，进而被上游吊销。这次扫描是刻意串行的——在长时间停机之后一次性刷新整批账号，会把令牌接口打成一波限流。

学习得来的配额（用量、各窗口、重置时间、订阅资料）会写入磁盘并在下次启动时恢复，因此重启后仪表盘和排序无需重新测量即可延续；`R` 重放所用的探测形态也以同样方式持久化。而按响应产生的临时信号则不会：冷却（cooldown）和错误状态会在重启时被有意丢弃，这样账号就不会被某个过期 429 的 retry-after 再次搁置——如果它确实已经用尽，下一个请求会重新推导出正确的状态。

当同时到达的请求数超过整批账号按账号并发上限所能承载的总量时，中继会在读取请求体之前就用 `429`（`x-teamai-429-reason: concurrency_saturated`）拒掉溢出的部分，而不是无上限地缓冲请求体。在"没有可用账号"的 429 上，同一个响应头也用来区分是账号繁忙还是已耗尽（`quota_exhausted`）。

`~D-N` 这个订阅数值是一个估算，并非权威的到期日期：Anthropic 的资料接口会暴露订阅状态和创建时间，但不提供当前计费周期的结束时间。因此 TeamAI 只能推算下一个月度计费周年日，并用 `~` 标注。资料状态会在服务端启动时刷新，此后每六小时刷新一次。

## 配置

配置和凭据存放在 `$TEAMAI_HOME` 中，若未设置则依次回退到 `$XDG_CONFIG_HOME/teamai` 和 `~/.config/teamai`。各代理均绑定在 `127.0.0.1` 上，并要求提供一个自动生成的本地客户端令牌。

`config.json` 会在首次运行时以下列默认值创建：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `proxy.host` | `127.0.0.1` | 绑定地址。按设计仅限回环地址。 |
| `proxy.claudePort` | `3456` | Claude 中继端口。 |
| `proxy.codexPort` | `3457` | Codex 中继端口。 |
| `proxy.controlPort` | `3556` | TUI 通信所用的控制通道。 |
| `proxy.clientToken` | 自动生成 | 每个被中继的客户端都必须发送的本地令牌。 |
| `switchThreshold` | `0.98` | 用量比例超过该值后，该账号不再被选中。 |
| `warmupIntervalMs` | `300000` | 后台重新测量的间隔。`0` 表示禁用。 |
| `maxConcurrentPerAccount` | `3` | 每个账号允许的并发在途请求数。 |
| `fableReserveThreshold` | `0.8` | 当账号的 Fable 窗口用量达到或超过该值时，优先把非 Fable 请求分给它。设为 1 关闭模型感知路由。 |
| `proxy.legacyPorts` | — | 可选。按提供方继续应答的额外端口 — 例如 { "claude": [3400] }。 |

如果某个端口已被别的程序占用，请改掉它——这正是启动失败最常见的原因，具体原因会记录在 `server-start.log` 中。

客户端的 base URL 是在启动时一次性交给它的，之后无法再重定向，因此若在 `config.json` 里改动端口，本会让每个已经打开的会话都陷入连接被拒。为此中继还会在内置的默认端口以及你在 `proxy.legacyPorts` 中列出的任意端口上应答，从而在端口变更时让已打开的会话保持存活。若某个旧端口已被别的程序占用，则会被跳过，并不影响主端口；而启动之后发生的套接字错误只会被记录下来，不会被放任而拖垮整个中继。

## 适用范围与合规

0.1 版本面向的是订阅制 OAuth 账号以及由包装器启动的 CLI 会话。它不对外提供 OpenAI 兼容的公开 API，不把 Claude 请求转换成 Codex 请求，不支持 Codex Desktop，也不会把不同人的凭据混在一个池里共用。遵守各服务商条款与政策的责任在你自己。生产环境／商业用途的 API 负载应当使用服务商官方的 API 计费方式。

## 开发

```bash
npm run typecheck
npm test
npm run lint
```

衍生作品相关说明见 [NOTICE](NOTICE)，本地安全模型见 [SECURITY.md](SECURITY.md)。
