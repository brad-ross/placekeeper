import importlib.util
import sys
import types
from unittest.mock import patch

commands = []
errors = []
sys.modules["sublime"] = types.SimpleNamespace(
    error_message=errors.append, set_timeout=lambda fn: fn(), set_timeout_async=lambda fn: fn())
sys.modules["sublime_plugin"] = types.SimpleNamespace(TextCommand=object)
spec = importlib.util.spec_from_file_location("placekeeper_recipe", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
settings = {"placekeeper_launcher": "/installed app/placekeeper", "placekeeper_pdf": "/build dir/main.pdf", "placekeeper_session": "s" * 43}
source = "/project/a'$`;.tex"
view = types.SimpleNamespace(settings=lambda: settings, file_name=lambda: source,
                             sel=lambda: [types.SimpleNamespace(begin=lambda: 10)], rowcol=lambda offset: (11, 4))
command = module.PlacekeeperForwardSyncTexCommand()
command.view = view

def run(argv, **options):
    assert options == {"capture_output": True, "text": True, "timeout": 15, "check": False}
    commands.append(argv)
    return types.SimpleNamespace(returncode=0, stdout="a" * 43, stderr="")

with patch.object(module.subprocess, "run", run):
    command.run(None)
assert commands == [["/installed app/placekeeper", "forward-search", "--pdf", "/build dir/main.pdf",
                     "--source", source, "--line", "12", "--session", "s" * 43]]
assert errors == []
print("helper checks passed")
