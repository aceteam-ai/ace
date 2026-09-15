/** The published node package is a node source, so Ace supplies the local CLI boundary. */
export const WORKFLOW_PYTHON_RUNNER = String.raw`
import asyncio
import importlib.metadata
import json
import sys
from pathlib import Path

ENGINE_VERSION = "2.0.0rc16"
NODES_VERSION = "0.8.0"


def emit(value):
    print(json.dumps(value, default=str))


def probe():
    try:
        if importlib.metadata.version("aceteam-workflow-engine") != ENGINE_VERSION:
            return False
        if importlib.metadata.version("aceteam-nodes") != NODES_VERSION:
            return False
        importlib.metadata.version("aceteam-aep")
        from aceteam_nodes.context import CLIContext
        from workflow_engine import WorkflowEngine
        return bool(CLIContext and WorkflowEngine)
    except (ImportError, importlib.metadata.PackageNotFoundError):
        return False


async def main():
    mode = sys.argv[1]
    if mode == "probe":
        ready = probe()
        emit({"ready": ready})
        return 0 if ready else 1

    from workflow_engine import Workflow, WorkflowEngine
    from workflow_engine.core.config import WorkflowEngineConfig
    from aceteam_nodes.context import CLIContext

    config = WorkflowEngineConfig.model_validate({
        "schema_version": 1,
        "nodes": {
            "Input": "aceteam-workflow-engine:Input",
            "Output": "aceteam-workflow-engine:Output",
            "LLM": "aceteam-nodes:LLM",
            "APICall": "aceteam-nodes:APICall",
        },
    })
    engine = await WorkflowEngine.from_config(config)
    if mode == "nodes":
        emit({"nodes": [
            {"type": name, "display_name": cls.TYPE_INFO.display_name,
             "description": cls.TYPE_INFO.description}
            for name, cls in engine.node_registry.items()
        ]})
        return 0

    path = Path(sys.argv[2])
    raw = json.loads(path.read_text())
    workflow = Workflow.model_validate(raw)
    if mode == "validate":
        await engine.validate(workflow)
        emit({"valid": True, "nodes": len(workflow.inner_nodes) + 2,
              "inputs": list(raw["input_node"]["params"]["fields"]),
              "outputs": list(raw["output_node"]["params"]["fields"])})
        return 0
    if mode != "run":
        raise ValueError("Unknown runner mode")

    input_data = json.loads(sys.argv[3])
    config_path = sys.argv[4] or "~/.ace/config.yaml"
    base_dir = sys.argv[5]
    context = CLIContext(config_path=config_path, base_dir=base_dir, verbose=True)
    # Ace has already resolved graph/--model selection; keep that model authoritative.
    context.config.pop("default_model", None)
    result = await engine.execute(context=context, workflow=workflow, input=input_data)
    data = result.model_dump(mode="json")
    errors = data.get("errors") or {}
    failed = bool(errors.get("workflow_errors") or errors.get("node_errors"))
    emit({"success": not failed, "output": data.get("output"), "errors": errors,
          **({"error": str(errors)} if failed else {})})
    return 1 if failed else 0


try:
    sys.exit(asyncio.run(main()))
except Exception as exc:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    emit({"valid": False, "success": False, "error": str(exc)})
    sys.exit(1)
`;
