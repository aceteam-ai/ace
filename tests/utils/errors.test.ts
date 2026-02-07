import { describe, it, expect } from "vitest";
import { classifyPythonError } from "../../src/utils/errors.js";

describe("classifyPythonError", () => {
  it("classifies ModuleNotFoundError for aceteam_nodes", () => {
    const raw = `Traceback (most recent call last):
  File "/usr/lib/python3.12/runpy.py", line 198, in _run_module_as_main
    return _run_code(code, main_globals, None,
ModuleNotFoundError: No module named 'aceteam_nodes'`;

    const result = classifyPythonError(raw);
    expect(result.message).toContain("aceteam_nodes");
    expect(result.suggestion).toContain("ace init");
  });

  it("classifies ModuleNotFoundError for other modules", () => {
    const raw = `ModuleNotFoundError: No module named 'torch'`;
    const result = classifyPythonError(raw);
    expect(result.message).toContain("torch");
    expect(result.suggestion).toContain("ace init");
  });

  it("classifies AuthenticationError", () => {
    const raw = `litellm.AuthenticationError: Incorrect API key provided`;
    const result = classifyPythonError(raw);
    expect(result.message).toContain("authentication");
    expect(result.suggestion).toContain("OPENAI_API_KEY");
  });

  it("classifies missing API key", () => {
    const raw = `Error: api_key must be set either as an environment variable or passed as an argument`;
    const result = classifyPythonError(raw);
    expect(result.message).toContain("authentication");
  });

  it("classifies Pydantic ValidationError", () => {
    const raw = `pydantic.ValidationError: 2 validation errors for WorkflowInput
  prompt
    Field required [type=missing, ...]
  temperature
    Input should be a valid number [type=float_type, ...]`;

    const result = classifyPythonError(raw);
    expect(result.message).toContain("Validation failed");
    expect(result.message).toContain("prompt");
  });

  it("classifies ConnectionError", () => {
    const raw = `ConnectionError: HTTPSConnectionPool(host='api.openai.com', port=443): Max retries exceeded`;
    const result = classifyPythonError(raw);
    expect(result.message).toContain("connection");
    expect(result.suggestion).toContain("internet");
  });

  it("classifies httpx.ConnectError", () => {
    const raw = `httpx.ConnectError: [Errno 111] Connection refused`;
    const result = classifyPythonError(raw);
    expect(result.message).toContain("connection");
  });

  it("classifies FileNotFoundError", () => {
    const raw = `FileNotFoundError: [Errno 2] No such file or directory: 'workflow.json'`;
    const result = classifyPythonError(raw);
    expect(result.message).toContain("not found");
    expect(result.suggestion).toContain("file path");
  });

  it("classifies TimeoutError", () => {
    const raw = `TimeoutError: Operation timed out after 30 seconds`;
    const result = classifyPythonError(raw);
    expect(result.message).toContain("timed out");
  });

  it("classifies RateLimitError", () => {
    const raw = `RateLimitError: You have exceeded your rate limit`;
    const result = classifyPythonError(raw);
    expect(result.message).toContain("Rate limited");
    expect(result.suggestion).toContain("Wait");
  });

  it("strips traceback for unknown errors", () => {
    const raw = `Traceback (most recent call last):
  File "something.py", line 42, in main
    do_stuff()
  File "other.py", line 10, in do_stuff
    raise ValueError("bad input")
ValueError: bad input`;

    const result = classifyPythonError(raw);
    expect(result.message).toBe("ValueError: bad input");
    expect(result.message).not.toContain("Traceback");
  });

  it("handles empty input", () => {
    const result = classifyPythonError("");
    expect(result.message).toBeDefined();
  });
});
