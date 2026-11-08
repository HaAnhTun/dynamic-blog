package com.blog.common.health;

import com.blog.common.response.ApiResponse;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * A liveness-and-readiness check for Docker Compose and a reverse proxy.
 *
 * <h2>Why not Actuator</h2>
 *
 * Spring Boot Actuator would give this for free, and it was considered. It is a new
 * dependency that exposes a tree of endpoints, each of which then has to be secured — and
 * the spec is explicit about preferring the simpler architecture and avoiding dependencies
 * added only because they are available. What a single-VPS deployment needs from a health
 * check is one question answered honestly: can this process serve a request that touches
 * the database? That is nine lines.
 *
 * <h2>It checks the database, which is the point</h2>
 *
 * A health check that returns 200 because the HTTP thread pool is alive tells an
 * orchestrator nothing it did not already know from the TCP connect. Every meaningful
 * request this API serves reads Postgres, so the check reads Postgres: if the connection
 * pool is exhausted or the database is gone, this says DOWN and answers 503, and the
 * proxy can stop sending traffic.
 *
 * {@code select 1} rather than a table read: it needs a connection from the pool and a
 * round trip, and nothing about the schema. A query against {@code posts} would start
 * failing during a migration that holds a lock, which is a deployment state, not an
 * unhealthy one.
 *
 * <h2>503, not 200 with a body saying DOWN</h2>
 *
 * The status code is the part an orchestrator reads. A check that always answers 200 and
 * puts the real answer in JSON is a check that every default configuration will believe.
 */
@RestController
@RequestMapping("/api/v1/health")
@RequiredArgsConstructor
public class HealthController {

    private static final Logger log = LoggerFactory.getLogger(HealthController.class);

    private final JdbcTemplate jdbcTemplate;

    @GetMapping
    public ResponseEntity<ApiResponse<Map<String, String>>> health() {
        boolean databaseUp;
        try {
            jdbcTemplate.queryForObject("select 1", Integer.class);
            databaseUp = true;
        } catch (RuntimeException e) {
            // Logged at warn with the exception type only. This endpoint is public, so the
            // body must not carry a driver message — a connection failure's text routinely
            // includes the host, the port and the database name.
            log.warn("Health check failed: {}", e.getClass().getSimpleName());
            databaseUp = false;
        }

        Map<String, String> body = Map.of(
                "status", databaseUp ? "UP" : "DOWN",
                "database", databaseUp ? "UP" : "DOWN");

        return ResponseEntity.status(databaseUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
                .body(ApiResponse.of(body));
    }
}
