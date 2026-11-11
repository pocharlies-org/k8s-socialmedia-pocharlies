import os
import sys

# Tests import the service package as `sync` (the container runs from /app).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
