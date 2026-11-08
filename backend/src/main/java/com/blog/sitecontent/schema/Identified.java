package com.blog.sitecontent.schema;

/** An item of a list that is addressed by an id or slug that must be unique inside the list. */
public interface Identified {

    String identity();
}
