FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
# Host-owned toolchain preparation, outside every agent-writable candidate.
RUN apt-get update
RUN apt-get install --yes --no-install-recommends git
