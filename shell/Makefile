PREFIX ?= $(HOME)/.local

install:
	@mkdir -p $(PREFIX)/bin
	@cp fleet-review $(PREFIX)/bin/fleet-review
	@chmod +x $(PREFIX)/bin/fleet-review
	@echo "Installed fleet-review to $(PREFIX)/bin/fleet-review"

uninstall:
	@rm -f $(PREFIX)/bin/fleet-review
	@echo "Removed fleet-review from $(PREFIX)/bin/fleet-review"

.PHONY: install uninstall
