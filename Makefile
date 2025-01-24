SHELL := /bin/bash
.PHONY: debug test

debug:
	hugo -D server

test:
	hugo server