## Claude Code: write `rm` so its guard does not stop you

- Write rm targets as explicit absolute paths; never "$VAR"/…, a $(cmd)-derived variable, or rm inside bash -c, so the dangerous-rm guard does not stop you.
