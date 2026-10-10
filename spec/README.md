# GameSpec 1.0

`GameSpec` 是自然语言规划与 Phaser 工程编译之间的唯一受控契约。系统必须先解析、根据 `gamespec.schema.json` 校验并规范化 LLM 输出，才可以交给编译器。

当前 MVP 的 `game.genre` 只接受 `flappy`、`shooter`、`runner` 三种类型。编译器依据类型选择经过验证的模板，再将 `config` 与文案填入多个 TypeScript 源文件；它不会把模型返回的任意代码直接执行。

规范化器会补齐缺失的默认值、收敛不受支持类型，并在需要时生成可解释的修复说明。`gamespec.example.json` 可作为端到端测试的基线输入。
