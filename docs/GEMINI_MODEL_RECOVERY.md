# Gemini 模型停用恢复

仅接口明确返回模型停用、不存在或不再支持（400/404/410）时触发；认证失败、配额和 5xx 不换模型。
查询官方模型列表，候选限定为稳定 Flash Lite，优先 `gemini-flash-lite-latest`，最多验证两个。候选先识别内置合成算式，答案正确才继续原请求。原业务解析与校验保留，恢复使用同一次调用的剩余时间。本进程缓存成功候选；不自动改写 GitHub 变量。

Python 策略源为 Pigbibi/AIGateway 的 `scripts/gemini_model_policy.py`；调用端保留相同副本以便 Gateway 服务不可用时仍可直接调用 Gemini，无新增运行依赖。两个 Node 调用端共用同一版本的 `src/gemini-model-policy.cjs`。修改策略时须运行对应停用恢复回归测试。

调用端的 `gemini-provider-probe.yml` 只手动运行合成图片和模拟停用恢复，不包含登录、短信或业务提交。模拟停用测试由客户端注入一次旧模型错误，后续模型列表、合成验证和识别均调用真实 Gemini；不声称该账号的旧模型已实际停用。OCR 和滑块定位算法不属于本次改动。
