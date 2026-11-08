# Two stages: a JDK to build, a JRE to run. The runtime image carries no Maven, no source
# and no build cache — which matters less for size than for what is reachable if the
# container is ever compromised.

# Both base images are pinned by digest (the tag says which version it is): a tag that moves would put different bytes into the published
# image than the ones that were tested. The Dependabot docker entry opens a pull request with the new tag and digest
# (scripts/test_image_pinning.py fails on a base image without a digest).
FROM maven:3.9-eclipse-temurin-26@sha256:b2c1ad85954592f9928e84327c65201f308ad9b5d8ed7d5b823717c97bf23fbb AS build
WORKDIR /build

# Dependencies before source, so editing a .java file does not re-download the world.
# go-offline is not perfect — a few plugins resolve at package time — but it moves the
# large majority of the downloads into a layer that only pom.xml invalidates.
COPY pom.xml .
# .mvn/maven.config makes a checksum mismatch fail the build (--strict-checksums), here as everywhere else.
COPY .mvn .mvn
RUN mvn -B -q dependency:go-offline

COPY src ./src
# Tests are NOT run here, deliberately. They need Testcontainers, which needs a Docker
# daemon, and reaching the host's daemon from inside a build is a privilege this image has
# no business holding. Tests run in CI and on a developer's machine, where `mvn clean test`
# has a daemon; a green image build is not evidence the suite passed and should not pretend
# to be.
RUN mvn -B -DskipTests package

FROM eclipse-temurin:25-jre-alpine@sha256:b7528962e65d43064d8a8b67ba175367896bc948363ea2d3fcd7f10d34e1f048 AS runtime
WORKDIR /app

# Non-root. The JVM needs nothing it writes to outside /tmp, so there is no reason for this
# process to be able to modify its own application code (the jar below is root-owned).
#
# Also removed: the Alpine package manager (so nothing can be installed into a compromised container) and the busybox netcat. The
# busybox wget stays on purpose, the compose healthcheck of the backend uses it; the JVM has its own networking anyway, so this
# narrows the toolbox, it does not close it.
RUN addgroup -S blog && adduser -S -G blog blog \
    && apk --purge del apk-tools \
    && rm -f /usr/bin/nc

# The only place the app writes besides /tmp: the first-run setup code file (a volume in compose).
RUN mkdir /data && chown blog:blog /data

COPY --from=build /build/target/blog-backend-1.0.0-rc.1.jar app.jar
USER blog

EXPOSE 8080

# Container-aware heap sizing. Without it the JVM reads the host's memory, not the
# container's limit, and a 512 MB container happily sizes a heap it cannot have.
# ExitOnOutOfMemoryError: after an OutOfMemoryError the JVM keeps running in an unknown state and a health check can still
# pass; exiting lets the restart policy of the compose file start a clean process.
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70 -XX:+UseSerialGC -XX:+ExitOnOutOfMemoryError"

# -Duser.timezone=UTC matches surefire and spring-boot-maven-plugin, so the running
# container agrees with the test suite about what `now()` means. The project has already
# paid for a timezone mismatch once.
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -Duser.timezone=UTC -jar app.jar"]
