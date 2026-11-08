package com.blog.support;

import java.time.Duration;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;

/**
 * A real Meilisearch for the whole JVM, like the Postgres of {@link AbstractIntegrationTest}: started once, Ryuk
 * cleans up when the JVM exits; random port, never the machine's 7700. The image is pinned to the compose version.
 * Container memory is 512 MiB and indexing memory 128 MiB: the test machine has only about 3 GB free.
 */
public final class MeiliTestContainer {

    /** Tests only: 32+ characters like the production startup rule. */
    public static final String MASTER_KEY = "meili-it-master-key-0123456789-abcdefghij";

    @SuppressWarnings("resource")
    public static final GenericContainer<?> CONTAINER = new GenericContainer<>(
                    DockerImageName.parse("getmeili/meilisearch:v1.54.3"))
            .withExposedPorts(7700)
            .withEnv("MEILI_ENV", "development")
            .withEnv("MEILI_MASTER_KEY", MASTER_KEY)
            .withEnv("MEILI_NO_ANALYTICS", "true")
            .withEnv("MEILI_MAX_INDEXING_MEMORY", "134217728")
            .withCreateContainerCmdModifier(command ->
                    command.getHostConfig().withMemory(512L * 1024 * 1024).withMemorySwap(512L * 1024 * 1024))
            .waitingFor(Wait.forHttp("/health").forStatusCode(200).withStartupTimeout(Duration.ofSeconds(60)));

    static {
        CONTAINER.start();
    }

    private MeiliTestContainer() {}

    public static String url() {
        return "http://" + CONTAINER.getHost() + ":" + CONTAINER.getMappedPort(7700);
    }

    /**
     * Engine hangs (no answer) until {@link #unpause()}: the port stays open, every request waits until it times out.
     */
    public static void pause() {
        CONTAINER
                .getDockerClient()
                .pauseContainerCmd(CONTAINER.getContainerId())
                .exec();
    }

    public static void unpause() {
        CONTAINER
                .getDockerClient()
                .unpauseContainerCmd(CONTAINER.getContainerId())
                .exec();
    }
}
