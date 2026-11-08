package com.blog.sitecontent.schema;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.Path;
import jakarta.validation.Validator;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.exc.UnrecognizedPropertyException;
import tools.jackson.databind.json.JsonMapper;

/**
 * Checks a payload against the typed record of its key: upgrade to the current version, bind with unknown properties
 * rejected and no scalar coercion (a number is not a string), then Bean Validation. The stored form is the typed record
 * written back, so what is stored has exactly the shape of the record and nothing else.
 *
 * Problems are {@code <json pointer>: <reason>} and never contain the value.
 */
@Component
public class SiteContentSchemas {

    /** Compact size cap of a payload: the jsonb text adds spaces, and the table CHECK allows 262144 bytes of that text. */
    public static final int MAX_PAYLOAD_BYTES = 200_000;

    static final int MAX_PROBLEMS = 5;

    private static final int MAX_NAME_LENGTH = 40;

    private static final JsonMapper MAPPER = JsonMapper.builder()
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .build();

    private final Validator validator;
    private final SiteContentUpgrades upgrades;

    public SiteContentSchemas(Validator validator, SiteContentUpgrades upgrades) {
        this.validator = validator;
        this.upgrades = upgrades;
    }

    /** The outcome of {@link #check}: {@code payload} is the normalized current-version payload when there is no problem. */
    public record Checked(JsonNode payload, List<String> problems) {

        public boolean valid() {
            return problems.isEmpty();
        }
    }

    public int currentVersion(SiteContentKey key) {
        return upgrades.currentVersion(key);
    }

    /**
     * Validates one section. {@code pointerPrefix} is where the section sits in the request ("" for a single PUT,
     * {@code /sections/<key>} in an import).
     */
    public Checked check(SiteContentKey key, Integer schemaVersion, JsonNode payload, String pointerPrefix) {
        if (schemaVersion == null || !upgrades.isKnown(key, schemaVersion)) {
            return problem(pointerPrefix + "/schemaVersion", "is not a supported schema version");
        }
        if (payload == null || !payload.isObject()) {
            return problem(pointerPrefix.isEmpty() ? "/" : pointerPrefix, "must be a JSON object");
        }
        JsonNode upgraded;
        try {
            upgraded = upgrades.upgrade(key, schemaVersion, payload);
        } catch (RuntimeException e) {
            return problem(pointerPrefix + "/schemaVersion", "cannot be upgraded to the current version");
        }
        // Every scalar of every schema is a text: Jackson would turn a number or a boolean into a string, so say no
        // here.
        List<String> notText = nonTextScalars(upgraded, pointerPrefix.isEmpty() ? "" : pointerPrefix);
        if (!notText.isEmpty()) {
            return new Checked(null, notText.stream().limit(MAX_PROBLEMS).toList());
        }
        Object bean;
        try {
            bean = MAPPER.treeToValue(upgraded, key.payloadType());
        } catch (JacksonException e) {
            return problem(
                    pointerPrefix + pointerOf(e),
                    e instanceof UnrecognizedPropertyException ? "is not a known property" : "has the wrong type");
        }
        Set<String> problems = new TreeSet<>();
        for (ConstraintViolation<Object> violation : validator.validate(bean)) {
            problems.add(pointerPrefix + pointerOf(violation.getPropertyPath()) + ": " + violation.getMessage());
        }
        if (!problems.isEmpty()) {
            return new Checked(null, problems.stream().limit(MAX_PROBLEMS).toList());
        }
        JsonNode normalized = MAPPER.valueToTree(bean);
        if (normalized.toString().getBytes(StandardCharsets.UTF_8).length > MAX_PAYLOAD_BYTES) {
            return problem(pointerPrefix.isEmpty() ? "/" : pointerPrefix, "is too large");
        }
        return new Checked(normalized, List.of());
    }

    /** Validates one section and throws {@code SITE_CONTENT_INVALID} (400) on any problem. */
    public JsonNode validate(SiteContentKey key, Integer schemaVersion, JsonNode payload) {
        Checked checked = check(key, schemaVersion, payload, "");
        if (!checked.valid()) {
            throw invalid(checked.problems());
        }
        return checked.payload();
    }

    /** A stored row on its way out: older versions are upgraded, nothing else is changed. */
    public JsonNode upgradeStored(SiteContentKey key, int storedVersion, JsonNode data) {
        if (!upgrades.isKnown(key, storedVersion)) {
            throw invalid(List.of("/schemaVersion: is not a supported schema version"));
        }
        try {
            return upgrades.upgrade(key, storedVersion, data);
        } catch (RuntimeException e) {
            throw invalid(List.of("/schemaVersion: cannot be upgraded to the current version"));
        }
    }

    public static ApiException invalid(List<String> problems) {
        return new ApiException(
                ErrorCode.SITE_CONTENT_INVALID,
                HttpStatus.BAD_REQUEST,
                String.join("; ", problems.stream().limit(MAX_PROBLEMS).toList()));
    }

    private static Checked problem(String pointer, String reason) {
        return new Checked(null, List.of(pointer + ": " + reason));
    }

    private static List<String> nonTextScalars(JsonNode node, String pointer) {
        List<String> found = new ArrayList<>();
        if (node.isObject()) {
            for (Map.Entry<String, JsonNode> field : node.properties()) {
                found.addAll(nonTextScalars(field.getValue(), pointer + "/" + escape(field.getKey())));
            }
        } else if (node.isArray()) {
            for (int i = 0; i < node.size(); i++) {
                found.addAll(nonTextScalars(node.get(i), pointer + "/" + i));
            }
        } else if (!node.isString() && !node.isNull()) {
            found.add((pointer.isEmpty() ? "/" : pointer) + ": has the wrong type");
        }
        return found;
    }

    private static String pointerOf(JacksonException e) {
        StringBuilder pointer = new StringBuilder();
        for (JacksonException.Reference reference : e.getPath()) {
            if (reference.getIndex() >= 0) {
                pointer.append('/').append(reference.getIndex());
            } else if (reference.getPropertyName() != null) {
                pointer.append('/').append(escape(reference.getPropertyName()));
            }
        }
        return pointer.toString();
    }

    private static String pointerOf(Path path) {
        List<String> parts = new ArrayList<>();
        for (Path.Node node : path) {
            if (node.isInIterable()) {
                parts.add(node.getIndex() != null ? node.getIndex().toString() : String.valueOf(node.getKey()));
            }
            String name = node.getName();
            if (name != null && !name.startsWith("<")) {
                parts.add(escape(name));
            }
        }
        return parts.isEmpty() ? "/" : "/" + String.join("/", parts);
    }

    /** A property name comes from the request: keep it short and printable, and escape the pointer characters. */
    private static String escape(String name) {
        String safe = name.length() > MAX_NAME_LENGTH ? name.substring(0, MAX_NAME_LENGTH) : name;
        StringBuilder out = new StringBuilder();
        for (char c : safe.toCharArray()) {
            if (c == '~') {
                out.append("~0");
            } else if (c == '/') {
                out.append("~1");
            } else {
                out.append(Character.isLetterOrDigit(c) || c == '_' || c == '-' || c == '.' ? c : '?');
            }
        }
        return out.toString();
    }
}
