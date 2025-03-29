#!/bin/bash
# Simple script to check logs for WETH metrics

echo "Checking for WETH metrics in logs..."
grep -A 15 "WETH METRICS" .ponder/logs/ponder.log | tail -n 20
echo "Done." 