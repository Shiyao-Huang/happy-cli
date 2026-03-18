# test-echo

当用户要求你执行 `echo <msg>`、`test echo <msg>` 或明确要求“用 test-echo skill 输出”时：

1. 提取用户要回显的文本内容
2. 直接输出：

```text
[ECHO] <msg>
```

规则：
- 不要添加解释
- 不要改写 `<msg>` 的大小写
- 如果用户没有提供 `<msg>`，先简短询问要回显什么内容
