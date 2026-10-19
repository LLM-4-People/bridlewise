.PHONY: install typecheck build test check guardian dev status stop clean

install:
	npm ci
	npm --prefix engine ci
	chmod 600 engine/bridlewise.config.json

typecheck:
	npm run typecheck
	npm --prefix engine run typecheck

build:
	npm run build
	npm --prefix engine run build:bundle

test:
	npm run test:public

check: typecheck test
	npm run check:secrets

guardian:
	make -C engine/guardian all
	make -C engine/guardian test

dev:
	node scripts/sd.mjs start

status:
	node scripts/sd.mjs status

stop:
	node scripts/sd.mjs stop

clean:
	rm -rf dist engine/dist engine/guardian/build
