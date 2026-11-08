package com.blog.sitecontent.schema;

import jakarta.validation.ConstraintValidatorContext;

/** Lets a validator give its own reason as the violation message. */
final class Violations {

    private Violations() {}

    static boolean report(ConstraintValidatorContext context, String problem) {
        if (problem == null) {
            return true;
        }
        context.disableDefaultConstraintViolation();
        context.buildConstraintViolationWithTemplate(problem).addConstraintViolation();
        return false;
    }
}
