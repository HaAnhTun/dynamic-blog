package com.blog.sitecontent.schema;

import java.util.HashMap;
import java.util.Map;
import java.util.function.UnaryOperator;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * The registry that turns a payload of an older schema version into the current one, one step at a time (version n to
 * n+1). Nothing is registered yet: every key is at version 1. A future schema change adds its upgrader here and raises
 * the current version of its key; tests build a registry with fake upgraders through the package-private constructor.
 */
@Component
public class SiteContentUpgrades {

    private final Map<SiteContentKey, Integer> currentVersions;
    private final Map<SiteContentKey, Map<Integer, UnaryOperator<JsonNode>>> upgraders;

    @Autowired
    public SiteContentUpgrades() {
        this(Map.of(), Map.of());
    }

    SiteContentUpgrades(
            Map<SiteContentKey, Integer> currentVersions,
            Map<SiteContentKey, Map<Integer, UnaryOperator<JsonNode>>> upgraders) {
        this.currentVersions = new HashMap<>(currentVersions);
        this.upgraders = new HashMap<>(upgraders);
    }

    public int currentVersion(SiteContentKey key) {
        return currentVersions.getOrDefault(key, SiteContentKey.CURRENT_VERSION);
    }

    public boolean isKnown(SiteContentKey key, int version) {
        return version >= 1 && version <= currentVersion(key);
    }

    /**
     * Runs the chain from {@code fromVersion} to the current version of the key.
     *
     * @throws IllegalArgumentException when the version is unknown or a step of the chain is not registered
     */
    public JsonNode upgrade(SiteContentKey key, int fromVersion, JsonNode payload) {
        if (!isKnown(key, fromVersion)) {
            throw new IllegalArgumentException("unknown schema version");
        }
        JsonNode result = payload;
        for (int version = fromVersion; version < currentVersion(key); version++) {
            UnaryOperator<JsonNode> step = upgraders.getOrDefault(key, Map.of()).get(version);
            if (step == null) {
                throw new IllegalArgumentException("no upgrader registered for schema version " + version);
            }
            result = step.apply(result);
        }
        return result;
    }
}
