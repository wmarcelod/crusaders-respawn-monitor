package com.github.manevolent.ts3j.license;

import com.github.manevolent.ts3j.enums.LicenseType;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

public class Ts5ServerLicenseUse extends LicenseUse {
    private byte type;
    private List<byte[]> properties;

    public Ts5ServerLicenseUse() {
        super();
        properties = new ArrayList<>();
    }

    @Override
    public int getSize() {
        int propertiesSize = 1; // first byte is property count
        for (byte[] property : properties) {
            propertiesSize += property.length + 1; // + 1 because the first byte is always the length of the property
        }
        return 1 + 4 + propertiesSize + 1;
    }

    @Override
    public LicenseUseType getUseType() {
        return LicenseUseType.TS5SERVER;
    }

    @Override
    public ByteBuffer write(ByteBuffer buffer) {
        buffer.put(type);

        buffer.put((byte) properties.size());
        for (byte[] property : properties) {
            buffer.put((byte) property.length);
            buffer.put(property);
        }

        return buffer;
    }

    @Override
    public ByteBuffer read(ByteBuffer buffer) {
        type = buffer.get();
        int propertyCount = buffer.get();

        for (int i = 0; i < propertyCount; i++) {
            int propertyLength = buffer.get();
            byte[] propertyBytes = new byte[propertyLength];
            buffer.get(propertyBytes);
            properties.add(propertyBytes);
        }

        return buffer;
    }

    public List<byte[]> getProperties() {
        return properties;
    }

    public LicenseType getLicenseType() {
        return LicenseType.fromId(type);
    }

    public void setType(byte type) {
        this.type = type;
    }

    public byte getType() {
        return type;
    }
}
