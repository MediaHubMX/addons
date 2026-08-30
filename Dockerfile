# Build context is the mhub-v2 directory, not this repo: the v1 bridge and the
# identity reader are served from the protocol repo next door.
#
#   docker build -f addons/Dockerfile ..
FROM node:22-alpine
WORKDIR /code
COPY protocol/packages/v1-bridge ./protocol/packages/v1-bridge
COPY protocol/packages/identity ./protocol/packages/identity
# The install comes after the sources, not before: a checkout carries its own
# node_modules, and copying it over a finished install puts the developer's
# tree in the image instead of the locked one.
COPY addons ./addons
RUN cd addons && rm -rf node_modules && npm ci --omit=dev
WORKDIR /code/addons
USER node
CMD ["node", "serve.mjs"]
