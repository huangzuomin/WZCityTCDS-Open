import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from packages.fpf_gates.hook_guard_dev import main
raise SystemExit(main())
