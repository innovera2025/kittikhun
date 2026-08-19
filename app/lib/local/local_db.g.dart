// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'local_db.dart';

// ignore_for_file: type=lint
class $LocalItemsTable extends LocalItems
    with TableInfo<$LocalItemsTable, LocalItem> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $LocalItemsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _skuMeta = const VerificationMeta('sku');
  @override
  late final GeneratedColumn<String> sku = GeneratedColumn<String>(
    'sku',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _nameEnMeta = const VerificationMeta('nameEn');
  @override
  late final GeneratedColumn<String> nameEn = GeneratedColumn<String>(
    'name_en',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _locMeta = const VerificationMeta('loc');
  @override
  late final GeneratedColumn<String> loc = GeneratedColumn<String>(
    'loc',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _unitMeta = const VerificationMeta('unit');
  @override
  late final GeneratedColumn<String> unit = GeneratedColumn<String>(
    'unit',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _onHandMeta = const VerificationMeta('onHand');
  @override
  late final GeneratedColumn<double> onHand = GeneratedColumn<double>(
    'on_hand',
    aliasedName,
    true,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _reservedMeta = const VerificationMeta(
    'reserved',
  );
  @override
  late final GeneratedColumn<double> reserved = GeneratedColumn<double>(
    'reserved',
    aliasedName,
    true,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _ropMeta = const VerificationMeta('rop');
  @override
  late final GeneratedColumn<double> rop = GeneratedColumn<double>(
    'rop',
    aliasedName,
    true,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _specsJsonMeta = const VerificationMeta(
    'specsJson',
  );
  @override
  late final GeneratedColumn<String> specsJson = GeneratedColumn<String>(
    'specs_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('{}'),
  );
  static const VerificationMeta _warehouseCodeMeta = const VerificationMeta(
    'warehouseCode',
  );
  @override
  late final GeneratedColumn<String> warehouseCode = GeneratedColumn<String>(
    'warehouse_code',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _rowVersionMeta = const VerificationMeta(
    'rowVersion',
  );
  @override
  late final GeneratedColumn<String> rowVersion = GeneratedColumn<String>(
    'row_version',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<DateTime> updatedAt = GeneratedColumn<DateTime>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    sku,
    name,
    nameEn,
    loc,
    unit,
    onHand,
    reserved,
    rop,
    specsJson,
    warehouseCode,
    rowVersion,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'local_items';
  @override
  VerificationContext validateIntegrity(
    Insertable<LocalItem> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('sku')) {
      context.handle(
        _skuMeta,
        sku.isAcceptableOrUnknown(data['sku']!, _skuMeta),
      );
    } else if (isInserting) {
      context.missing(_skuMeta);
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    } else if (isInserting) {
      context.missing(_nameMeta);
    }
    if (data.containsKey('name_en')) {
      context.handle(
        _nameEnMeta,
        nameEn.isAcceptableOrUnknown(data['name_en']!, _nameEnMeta),
      );
    }
    if (data.containsKey('loc')) {
      context.handle(
        _locMeta,
        loc.isAcceptableOrUnknown(data['loc']!, _locMeta),
      );
    }
    if (data.containsKey('unit')) {
      context.handle(
        _unitMeta,
        unit.isAcceptableOrUnknown(data['unit']!, _unitMeta),
      );
    }
    if (data.containsKey('on_hand')) {
      context.handle(
        _onHandMeta,
        onHand.isAcceptableOrUnknown(data['on_hand']!, _onHandMeta),
      );
    }
    if (data.containsKey('reserved')) {
      context.handle(
        _reservedMeta,
        reserved.isAcceptableOrUnknown(data['reserved']!, _reservedMeta),
      );
    }
    if (data.containsKey('rop')) {
      context.handle(
        _ropMeta,
        rop.isAcceptableOrUnknown(data['rop']!, _ropMeta),
      );
    }
    if (data.containsKey('specs_json')) {
      context.handle(
        _specsJsonMeta,
        specsJson.isAcceptableOrUnknown(data['specs_json']!, _specsJsonMeta),
      );
    }
    if (data.containsKey('warehouse_code')) {
      context.handle(
        _warehouseCodeMeta,
        warehouseCode.isAcceptableOrUnknown(
          data['warehouse_code']!,
          _warehouseCodeMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_warehouseCodeMeta);
    }
    if (data.containsKey('row_version')) {
      context.handle(
        _rowVersionMeta,
        rowVersion.isAcceptableOrUnknown(data['row_version']!, _rowVersionMeta),
      );
    } else if (isInserting) {
      context.missing(_rowVersionMeta);
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {sku};
  @override
  LocalItem map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return LocalItem(
      sku: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}sku'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      nameEn: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name_en'],
      ),
      loc: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}loc'],
      ),
      unit: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}unit'],
      ),
      onHand: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}on_hand'],
      ),
      reserved: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}reserved'],
      ),
      rop: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}rop'],
      ),
      specsJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}specs_json'],
      )!,
      warehouseCode: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}warehouse_code'],
      )!,
      rowVersion: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}row_version'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $LocalItemsTable createAlias(String alias) {
    return $LocalItemsTable(attachedDatabase, alias);
  }
}

class LocalItem extends DataClass implements Insertable<LocalItem> {
  /// `InventoryItem.ItemCode`
  final String sku;
  final String name;
  final String? nameEn;
  final String? loc;

  /// `MainUnits` — nullable ในตาราง แต่ [Item.unit] เป็น String → map '' ↔ null
  final String? unit;

  /// ⚠️ null = ไม่มีข้อมูลยอด (ห้าม default 0)
  final double? onHand;
  final double? reserved;
  final double? rop;

  /// ฟิลด์ผ่านทางที่ไม่มีคอลัมน์ของตัวเอง (JSON object):
  /// `updated` (ป้ายเวลาอัปเดตตาม design) · `vendor` · `lot` · `lastCountDate`
  final String specsJson;

  /// '' = ไม่ระบุคลัง (map เป็น null ตอนคืนเป็น [Item])
  final String warehouseCode;

  /// cursor ของแถว — เก็บเป็น string เพราะฝั่ง server เป็น bigint
  final String rowVersion;

  /// เวลาที่เขียนแถวนี้ลง replica (ไม่ใช่เวลาที่ ERP แก้ข้อมูล — อันนั้นอยู่ใน
  /// `specsJson.updated` ซึ่งเป็นป้ายข้อความจาก server)
  final DateTime updatedAt;
  const LocalItem({
    required this.sku,
    required this.name,
    this.nameEn,
    this.loc,
    this.unit,
    this.onHand,
    this.reserved,
    this.rop,
    required this.specsJson,
    required this.warehouseCode,
    required this.rowVersion,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['sku'] = Variable<String>(sku);
    map['name'] = Variable<String>(name);
    if (!nullToAbsent || nameEn != null) {
      map['name_en'] = Variable<String>(nameEn);
    }
    if (!nullToAbsent || loc != null) {
      map['loc'] = Variable<String>(loc);
    }
    if (!nullToAbsent || unit != null) {
      map['unit'] = Variable<String>(unit);
    }
    if (!nullToAbsent || onHand != null) {
      map['on_hand'] = Variable<double>(onHand);
    }
    if (!nullToAbsent || reserved != null) {
      map['reserved'] = Variable<double>(reserved);
    }
    if (!nullToAbsent || rop != null) {
      map['rop'] = Variable<double>(rop);
    }
    map['specs_json'] = Variable<String>(specsJson);
    map['warehouse_code'] = Variable<String>(warehouseCode);
    map['row_version'] = Variable<String>(rowVersion);
    map['updated_at'] = Variable<DateTime>(updatedAt);
    return map;
  }

  LocalItemsCompanion toCompanion(bool nullToAbsent) {
    return LocalItemsCompanion(
      sku: Value(sku),
      name: Value(name),
      nameEn: nameEn == null && nullToAbsent
          ? const Value.absent()
          : Value(nameEn),
      loc: loc == null && nullToAbsent ? const Value.absent() : Value(loc),
      unit: unit == null && nullToAbsent ? const Value.absent() : Value(unit),
      onHand: onHand == null && nullToAbsent
          ? const Value.absent()
          : Value(onHand),
      reserved: reserved == null && nullToAbsent
          ? const Value.absent()
          : Value(reserved),
      rop: rop == null && nullToAbsent ? const Value.absent() : Value(rop),
      specsJson: Value(specsJson),
      warehouseCode: Value(warehouseCode),
      rowVersion: Value(rowVersion),
      updatedAt: Value(updatedAt),
    );
  }

  factory LocalItem.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return LocalItem(
      sku: serializer.fromJson<String>(json['sku']),
      name: serializer.fromJson<String>(json['name']),
      nameEn: serializer.fromJson<String?>(json['nameEn']),
      loc: serializer.fromJson<String?>(json['loc']),
      unit: serializer.fromJson<String?>(json['unit']),
      onHand: serializer.fromJson<double?>(json['onHand']),
      reserved: serializer.fromJson<double?>(json['reserved']),
      rop: serializer.fromJson<double?>(json['rop']),
      specsJson: serializer.fromJson<String>(json['specsJson']),
      warehouseCode: serializer.fromJson<String>(json['warehouseCode']),
      rowVersion: serializer.fromJson<String>(json['rowVersion']),
      updatedAt: serializer.fromJson<DateTime>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'sku': serializer.toJson<String>(sku),
      'name': serializer.toJson<String>(name),
      'nameEn': serializer.toJson<String?>(nameEn),
      'loc': serializer.toJson<String?>(loc),
      'unit': serializer.toJson<String?>(unit),
      'onHand': serializer.toJson<double?>(onHand),
      'reserved': serializer.toJson<double?>(reserved),
      'rop': serializer.toJson<double?>(rop),
      'specsJson': serializer.toJson<String>(specsJson),
      'warehouseCode': serializer.toJson<String>(warehouseCode),
      'rowVersion': serializer.toJson<String>(rowVersion),
      'updatedAt': serializer.toJson<DateTime>(updatedAt),
    };
  }

  LocalItem copyWith({
    String? sku,
    String? name,
    Value<String?> nameEn = const Value.absent(),
    Value<String?> loc = const Value.absent(),
    Value<String?> unit = const Value.absent(),
    Value<double?> onHand = const Value.absent(),
    Value<double?> reserved = const Value.absent(),
    Value<double?> rop = const Value.absent(),
    String? specsJson,
    String? warehouseCode,
    String? rowVersion,
    DateTime? updatedAt,
  }) => LocalItem(
    sku: sku ?? this.sku,
    name: name ?? this.name,
    nameEn: nameEn.present ? nameEn.value : this.nameEn,
    loc: loc.present ? loc.value : this.loc,
    unit: unit.present ? unit.value : this.unit,
    onHand: onHand.present ? onHand.value : this.onHand,
    reserved: reserved.present ? reserved.value : this.reserved,
    rop: rop.present ? rop.value : this.rop,
    specsJson: specsJson ?? this.specsJson,
    warehouseCode: warehouseCode ?? this.warehouseCode,
    rowVersion: rowVersion ?? this.rowVersion,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  LocalItem copyWithCompanion(LocalItemsCompanion data) {
    return LocalItem(
      sku: data.sku.present ? data.sku.value : this.sku,
      name: data.name.present ? data.name.value : this.name,
      nameEn: data.nameEn.present ? data.nameEn.value : this.nameEn,
      loc: data.loc.present ? data.loc.value : this.loc,
      unit: data.unit.present ? data.unit.value : this.unit,
      onHand: data.onHand.present ? data.onHand.value : this.onHand,
      reserved: data.reserved.present ? data.reserved.value : this.reserved,
      rop: data.rop.present ? data.rop.value : this.rop,
      specsJson: data.specsJson.present ? data.specsJson.value : this.specsJson,
      warehouseCode: data.warehouseCode.present
          ? data.warehouseCode.value
          : this.warehouseCode,
      rowVersion: data.rowVersion.present
          ? data.rowVersion.value
          : this.rowVersion,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('LocalItem(')
          ..write('sku: $sku, ')
          ..write('name: $name, ')
          ..write('nameEn: $nameEn, ')
          ..write('loc: $loc, ')
          ..write('unit: $unit, ')
          ..write('onHand: $onHand, ')
          ..write('reserved: $reserved, ')
          ..write('rop: $rop, ')
          ..write('specsJson: $specsJson, ')
          ..write('warehouseCode: $warehouseCode, ')
          ..write('rowVersion: $rowVersion, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    sku,
    name,
    nameEn,
    loc,
    unit,
    onHand,
    reserved,
    rop,
    specsJson,
    warehouseCode,
    rowVersion,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is LocalItem &&
          other.sku == this.sku &&
          other.name == this.name &&
          other.nameEn == this.nameEn &&
          other.loc == this.loc &&
          other.unit == this.unit &&
          other.onHand == this.onHand &&
          other.reserved == this.reserved &&
          other.rop == this.rop &&
          other.specsJson == this.specsJson &&
          other.warehouseCode == this.warehouseCode &&
          other.rowVersion == this.rowVersion &&
          other.updatedAt == this.updatedAt);
}

class LocalItemsCompanion extends UpdateCompanion<LocalItem> {
  final Value<String> sku;
  final Value<String> name;
  final Value<String?> nameEn;
  final Value<String?> loc;
  final Value<String?> unit;
  final Value<double?> onHand;
  final Value<double?> reserved;
  final Value<double?> rop;
  final Value<String> specsJson;
  final Value<String> warehouseCode;
  final Value<String> rowVersion;
  final Value<DateTime> updatedAt;
  final Value<int> rowid;
  const LocalItemsCompanion({
    this.sku = const Value.absent(),
    this.name = const Value.absent(),
    this.nameEn = const Value.absent(),
    this.loc = const Value.absent(),
    this.unit = const Value.absent(),
    this.onHand = const Value.absent(),
    this.reserved = const Value.absent(),
    this.rop = const Value.absent(),
    this.specsJson = const Value.absent(),
    this.warehouseCode = const Value.absent(),
    this.rowVersion = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  LocalItemsCompanion.insert({
    required String sku,
    required String name,
    this.nameEn = const Value.absent(),
    this.loc = const Value.absent(),
    this.unit = const Value.absent(),
    this.onHand = const Value.absent(),
    this.reserved = const Value.absent(),
    this.rop = const Value.absent(),
    this.specsJson = const Value.absent(),
    required String warehouseCode,
    required String rowVersion,
    required DateTime updatedAt,
    this.rowid = const Value.absent(),
  }) : sku = Value(sku),
       name = Value(name),
       warehouseCode = Value(warehouseCode),
       rowVersion = Value(rowVersion),
       updatedAt = Value(updatedAt);
  static Insertable<LocalItem> custom({
    Expression<String>? sku,
    Expression<String>? name,
    Expression<String>? nameEn,
    Expression<String>? loc,
    Expression<String>? unit,
    Expression<double>? onHand,
    Expression<double>? reserved,
    Expression<double>? rop,
    Expression<String>? specsJson,
    Expression<String>? warehouseCode,
    Expression<String>? rowVersion,
    Expression<DateTime>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (sku != null) 'sku': sku,
      if (name != null) 'name': name,
      if (nameEn != null) 'name_en': nameEn,
      if (loc != null) 'loc': loc,
      if (unit != null) 'unit': unit,
      if (onHand != null) 'on_hand': onHand,
      if (reserved != null) 'reserved': reserved,
      if (rop != null) 'rop': rop,
      if (specsJson != null) 'specs_json': specsJson,
      if (warehouseCode != null) 'warehouse_code': warehouseCode,
      if (rowVersion != null) 'row_version': rowVersion,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  LocalItemsCompanion copyWith({
    Value<String>? sku,
    Value<String>? name,
    Value<String?>? nameEn,
    Value<String?>? loc,
    Value<String?>? unit,
    Value<double?>? onHand,
    Value<double?>? reserved,
    Value<double?>? rop,
    Value<String>? specsJson,
    Value<String>? warehouseCode,
    Value<String>? rowVersion,
    Value<DateTime>? updatedAt,
    Value<int>? rowid,
  }) {
    return LocalItemsCompanion(
      sku: sku ?? this.sku,
      name: name ?? this.name,
      nameEn: nameEn ?? this.nameEn,
      loc: loc ?? this.loc,
      unit: unit ?? this.unit,
      onHand: onHand ?? this.onHand,
      reserved: reserved ?? this.reserved,
      rop: rop ?? this.rop,
      specsJson: specsJson ?? this.specsJson,
      warehouseCode: warehouseCode ?? this.warehouseCode,
      rowVersion: rowVersion ?? this.rowVersion,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (sku.present) {
      map['sku'] = Variable<String>(sku.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (nameEn.present) {
      map['name_en'] = Variable<String>(nameEn.value);
    }
    if (loc.present) {
      map['loc'] = Variable<String>(loc.value);
    }
    if (unit.present) {
      map['unit'] = Variable<String>(unit.value);
    }
    if (onHand.present) {
      map['on_hand'] = Variable<double>(onHand.value);
    }
    if (reserved.present) {
      map['reserved'] = Variable<double>(reserved.value);
    }
    if (rop.present) {
      map['rop'] = Variable<double>(rop.value);
    }
    if (specsJson.present) {
      map['specs_json'] = Variable<String>(specsJson.value);
    }
    if (warehouseCode.present) {
      map['warehouse_code'] = Variable<String>(warehouseCode.value);
    }
    if (rowVersion.present) {
      map['row_version'] = Variable<String>(rowVersion.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<DateTime>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('LocalItemsCompanion(')
          ..write('sku: $sku, ')
          ..write('name: $name, ')
          ..write('nameEn: $nameEn, ')
          ..write('loc: $loc, ')
          ..write('unit: $unit, ')
          ..write('onHand: $onHand, ')
          ..write('reserved: $reserved, ')
          ..write('rop: $rop, ')
          ..write('specsJson: $specsJson, ')
          ..write('warehouseCode: $warehouseCode, ')
          ..write('rowVersion: $rowVersion, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $LocalBarcodesTable extends LocalBarcodes
    with TableInfo<$LocalBarcodesTable, LocalBarcode> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $LocalBarcodesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _barcodeMeta = const VerificationMeta(
    'barcode',
  );
  @override
  late final GeneratedColumn<String> barcode = GeneratedColumn<String>(
    'barcode',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _skuMeta = const VerificationMeta('sku');
  @override
  late final GeneratedColumn<String> sku = GeneratedColumn<String>(
    'sku',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [barcode, sku];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'local_barcodes';
  @override
  VerificationContext validateIntegrity(
    Insertable<LocalBarcode> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('barcode')) {
      context.handle(
        _barcodeMeta,
        barcode.isAcceptableOrUnknown(data['barcode']!, _barcodeMeta),
      );
    } else if (isInserting) {
      context.missing(_barcodeMeta);
    }
    if (data.containsKey('sku')) {
      context.handle(
        _skuMeta,
        sku.isAcceptableOrUnknown(data['sku']!, _skuMeta),
      );
    } else if (isInserting) {
      context.missing(_skuMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {barcode};
  @override
  LocalBarcode map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return LocalBarcode(
      barcode: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}barcode'],
      )!,
      sku: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}sku'],
      )!,
    );
  }

  @override
  $LocalBarcodesTable createAlias(String alias) {
    return $LocalBarcodesTable(attachedDatabase, alias);
  }
}

class LocalBarcode extends DataClass implements Insertable<LocalBarcode> {
  final String barcode;
  final String sku;
  const LocalBarcode({required this.barcode, required this.sku});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['barcode'] = Variable<String>(barcode);
    map['sku'] = Variable<String>(sku);
    return map;
  }

  LocalBarcodesCompanion toCompanion(bool nullToAbsent) {
    return LocalBarcodesCompanion(barcode: Value(barcode), sku: Value(sku));
  }

  factory LocalBarcode.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return LocalBarcode(
      barcode: serializer.fromJson<String>(json['barcode']),
      sku: serializer.fromJson<String>(json['sku']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'barcode': serializer.toJson<String>(barcode),
      'sku': serializer.toJson<String>(sku),
    };
  }

  LocalBarcode copyWith({String? barcode, String? sku}) =>
      LocalBarcode(barcode: barcode ?? this.barcode, sku: sku ?? this.sku);
  LocalBarcode copyWithCompanion(LocalBarcodesCompanion data) {
    return LocalBarcode(
      barcode: data.barcode.present ? data.barcode.value : this.barcode,
      sku: data.sku.present ? data.sku.value : this.sku,
    );
  }

  @override
  String toString() {
    return (StringBuffer('LocalBarcode(')
          ..write('barcode: $barcode, ')
          ..write('sku: $sku')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(barcode, sku);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is LocalBarcode &&
          other.barcode == this.barcode &&
          other.sku == this.sku);
}

class LocalBarcodesCompanion extends UpdateCompanion<LocalBarcode> {
  final Value<String> barcode;
  final Value<String> sku;
  final Value<int> rowid;
  const LocalBarcodesCompanion({
    this.barcode = const Value.absent(),
    this.sku = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  LocalBarcodesCompanion.insert({
    required String barcode,
    required String sku,
    this.rowid = const Value.absent(),
  }) : barcode = Value(barcode),
       sku = Value(sku);
  static Insertable<LocalBarcode> custom({
    Expression<String>? barcode,
    Expression<String>? sku,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (barcode != null) 'barcode': barcode,
      if (sku != null) 'sku': sku,
      if (rowid != null) 'rowid': rowid,
    });
  }

  LocalBarcodesCompanion copyWith({
    Value<String>? barcode,
    Value<String>? sku,
    Value<int>? rowid,
  }) {
    return LocalBarcodesCompanion(
      barcode: barcode ?? this.barcode,
      sku: sku ?? this.sku,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (barcode.present) {
      map['barcode'] = Variable<String>(barcode.value);
    }
    if (sku.present) {
      map['sku'] = Variable<String>(sku.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('LocalBarcodesCompanion(')
          ..write('barcode: $barcode, ')
          ..write('sku: $sku, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $LocalMembersTable extends LocalMembers
    with TableInfo<$LocalMembersTable, LocalMember> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $LocalMembersTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _empIdMeta = const VerificationMeta('empId');
  @override
  late final GeneratedColumn<String> empId = GeneratedColumn<String>(
    'emp_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _shiftMeta = const VerificationMeta('shift');
  @override
  late final GeneratedColumn<String> shift = GeneratedColumn<String>(
    'shift',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _roleMeta = const VerificationMeta('role');
  @override
  late final GeneratedColumn<String> role = GeneratedColumn<String>(
    'role',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [empId, name, shift, role];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'local_members';
  @override
  VerificationContext validateIntegrity(
    Insertable<LocalMember> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('emp_id')) {
      context.handle(
        _empIdMeta,
        empId.isAcceptableOrUnknown(data['emp_id']!, _empIdMeta),
      );
    } else if (isInserting) {
      context.missing(_empIdMeta);
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    } else if (isInserting) {
      context.missing(_nameMeta);
    }
    if (data.containsKey('shift')) {
      context.handle(
        _shiftMeta,
        shift.isAcceptableOrUnknown(data['shift']!, _shiftMeta),
      );
    } else if (isInserting) {
      context.missing(_shiftMeta);
    }
    if (data.containsKey('role')) {
      context.handle(
        _roleMeta,
        role.isAcceptableOrUnknown(data['role']!, _roleMeta),
      );
    } else if (isInserting) {
      context.missing(_roleMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {empId};
  @override
  LocalMember map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return LocalMember(
      empId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}emp_id'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      shift: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}shift'],
      )!,
      role: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}role'],
      )!,
    );
  }

  @override
  $LocalMembersTable createAlias(String alias) {
    return $LocalMembersTable(attachedDatabase, alias);
  }
}

class LocalMember extends DataClass implements Insertable<LocalMember> {
  final String empId;
  final String name;
  final String shift;

  /// [Role.label] เช่น 'ADMIN' — ค่าที่อ่านไม่ออกถูก map เป็น viewer (fail-closed)
  final String role;
  const LocalMember({
    required this.empId,
    required this.name,
    required this.shift,
    required this.role,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['emp_id'] = Variable<String>(empId);
    map['name'] = Variable<String>(name);
    map['shift'] = Variable<String>(shift);
    map['role'] = Variable<String>(role);
    return map;
  }

  LocalMembersCompanion toCompanion(bool nullToAbsent) {
    return LocalMembersCompanion(
      empId: Value(empId),
      name: Value(name),
      shift: Value(shift),
      role: Value(role),
    );
  }

  factory LocalMember.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return LocalMember(
      empId: serializer.fromJson<String>(json['empId']),
      name: serializer.fromJson<String>(json['name']),
      shift: serializer.fromJson<String>(json['shift']),
      role: serializer.fromJson<String>(json['role']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'empId': serializer.toJson<String>(empId),
      'name': serializer.toJson<String>(name),
      'shift': serializer.toJson<String>(shift),
      'role': serializer.toJson<String>(role),
    };
  }

  LocalMember copyWith({
    String? empId,
    String? name,
    String? shift,
    String? role,
  }) => LocalMember(
    empId: empId ?? this.empId,
    name: name ?? this.name,
    shift: shift ?? this.shift,
    role: role ?? this.role,
  );
  LocalMember copyWithCompanion(LocalMembersCompanion data) {
    return LocalMember(
      empId: data.empId.present ? data.empId.value : this.empId,
      name: data.name.present ? data.name.value : this.name,
      shift: data.shift.present ? data.shift.value : this.shift,
      role: data.role.present ? data.role.value : this.role,
    );
  }

  @override
  String toString() {
    return (StringBuffer('LocalMember(')
          ..write('empId: $empId, ')
          ..write('name: $name, ')
          ..write('shift: $shift, ')
          ..write('role: $role')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(empId, name, shift, role);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is LocalMember &&
          other.empId == this.empId &&
          other.name == this.name &&
          other.shift == this.shift &&
          other.role == this.role);
}

class LocalMembersCompanion extends UpdateCompanion<LocalMember> {
  final Value<String> empId;
  final Value<String> name;
  final Value<String> shift;
  final Value<String> role;
  final Value<int> rowid;
  const LocalMembersCompanion({
    this.empId = const Value.absent(),
    this.name = const Value.absent(),
    this.shift = const Value.absent(),
    this.role = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  LocalMembersCompanion.insert({
    required String empId,
    required String name,
    required String shift,
    required String role,
    this.rowid = const Value.absent(),
  }) : empId = Value(empId),
       name = Value(name),
       shift = Value(shift),
       role = Value(role);
  static Insertable<LocalMember> custom({
    Expression<String>? empId,
    Expression<String>? name,
    Expression<String>? shift,
    Expression<String>? role,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (empId != null) 'emp_id': empId,
      if (name != null) 'name': name,
      if (shift != null) 'shift': shift,
      if (role != null) 'role': role,
      if (rowid != null) 'rowid': rowid,
    });
  }

  LocalMembersCompanion copyWith({
    Value<String>? empId,
    Value<String>? name,
    Value<String>? shift,
    Value<String>? role,
    Value<int>? rowid,
  }) {
    return LocalMembersCompanion(
      empId: empId ?? this.empId,
      name: name ?? this.name,
      shift: shift ?? this.shift,
      role: role ?? this.role,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (empId.present) {
      map['emp_id'] = Variable<String>(empId.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (shift.present) {
      map['shift'] = Variable<String>(shift.value);
    }
    if (role.present) {
      map['role'] = Variable<String>(role.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('LocalMembersCompanion(')
          ..write('empId: $empId, ')
          ..write('name: $name, ')
          ..write('shift: $shift, ')
          ..write('role: $role, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $LocalSessionTable extends LocalSession
    with TableInfo<$LocalSessionTable, LocalSessionData> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $LocalSessionTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _voucherNoMeta = const VerificationMeta(
    'voucherNo',
  );
  @override
  late final GeneratedColumn<String> voucherNo = GeneratedColumn<String>(
    'voucher_no',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _zoneMeta = const VerificationMeta('zone');
  @override
  late final GeneratedColumn<String> zone = GeneratedColumn<String>(
    'zone',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _warehouseCodeMeta = const VerificationMeta(
    'warehouseCode',
  );
  @override
  late final GeneratedColumn<String> warehouseCode = GeneratedColumn<String>(
    'warehouse_code',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _openedAtMeta = const VerificationMeta(
    'openedAt',
  );
  @override
  late final GeneratedColumn<DateTime> openedAt = GeneratedColumn<DateTime>(
    'opened_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _dataAsOfMeta = const VerificationMeta(
    'dataAsOf',
  );
  @override
  late final GeneratedColumn<DateTime> dataAsOf = GeneratedColumn<DateTime>(
    'data_as_of',
    aliasedName,
    true,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _staleCacheMeta = const VerificationMeta(
    'staleCache',
  );
  @override
  late final GeneratedColumn<bool> staleCache = GeneratedColumn<bool>(
    'stale_cache',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("stale_cache" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    voucherNo,
    zone,
    warehouseCode,
    openedAt,
    dataAsOf,
    staleCache,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'local_session';
  @override
  VerificationContext validateIntegrity(
    Insertable<LocalSessionData> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('voucher_no')) {
      context.handle(
        _voucherNoMeta,
        voucherNo.isAcceptableOrUnknown(data['voucher_no']!, _voucherNoMeta),
      );
    }
    if (data.containsKey('zone')) {
      context.handle(
        _zoneMeta,
        zone.isAcceptableOrUnknown(data['zone']!, _zoneMeta),
      );
    }
    if (data.containsKey('warehouse_code')) {
      context.handle(
        _warehouseCodeMeta,
        warehouseCode.isAcceptableOrUnknown(
          data['warehouse_code']!,
          _warehouseCodeMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_warehouseCodeMeta);
    }
    if (data.containsKey('opened_at')) {
      context.handle(
        _openedAtMeta,
        openedAt.isAcceptableOrUnknown(data['opened_at']!, _openedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_openedAtMeta);
    }
    if (data.containsKey('data_as_of')) {
      context.handle(
        _dataAsOfMeta,
        dataAsOf.isAcceptableOrUnknown(data['data_as_of']!, _dataAsOfMeta),
      );
    }
    if (data.containsKey('stale_cache')) {
      context.handle(
        _staleCacheMeta,
        staleCache.isAcceptableOrUnknown(data['stale_cache']!, _staleCacheMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  LocalSessionData map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return LocalSessionData(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      voucherNo: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}voucher_no'],
      ),
      zone: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}zone'],
      ),
      warehouseCode: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}warehouse_code'],
      )!,
      openedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}opened_at'],
      )!,
      dataAsOf: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}data_as_of'],
      ),
      staleCache: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}stale_cache'],
      )!,
    );
  }

  @override
  $LocalSessionTable createAlias(String alias) {
    return $LocalSessionTable(attachedDatabase, alias);
  }
}

class LocalSessionData extends DataClass
    implements Insertable<LocalSessionData> {
  /// คีย์จริงของรอบนับ (⚠️ `voucherNo` ซ้ำได้ ห้ามใช้เป็นคีย์)
  final String id;
  final String? voucherNo;
  final String? zone;
  final String warehouseCode;
  final DateTime openedAt;

  /// อายุข้อมูลยอดระบบ ณ เวลาที่ freeze (`erpDataAsOf`)
  final DateTime? dataAsOf;

  /// admin เปิดรอบตอน ERP ล่มโดยยืนยันจาก cache เก่า → UI ต้องเตือน
  final bool staleCache;
  const LocalSessionData({
    required this.id,
    this.voucherNo,
    this.zone,
    required this.warehouseCode,
    required this.openedAt,
    this.dataAsOf,
    required this.staleCache,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    if (!nullToAbsent || voucherNo != null) {
      map['voucher_no'] = Variable<String>(voucherNo);
    }
    if (!nullToAbsent || zone != null) {
      map['zone'] = Variable<String>(zone);
    }
    map['warehouse_code'] = Variable<String>(warehouseCode);
    map['opened_at'] = Variable<DateTime>(openedAt);
    if (!nullToAbsent || dataAsOf != null) {
      map['data_as_of'] = Variable<DateTime>(dataAsOf);
    }
    map['stale_cache'] = Variable<bool>(staleCache);
    return map;
  }

  LocalSessionCompanion toCompanion(bool nullToAbsent) {
    return LocalSessionCompanion(
      id: Value(id),
      voucherNo: voucherNo == null && nullToAbsent
          ? const Value.absent()
          : Value(voucherNo),
      zone: zone == null && nullToAbsent ? const Value.absent() : Value(zone),
      warehouseCode: Value(warehouseCode),
      openedAt: Value(openedAt),
      dataAsOf: dataAsOf == null && nullToAbsent
          ? const Value.absent()
          : Value(dataAsOf),
      staleCache: Value(staleCache),
    );
  }

  factory LocalSessionData.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return LocalSessionData(
      id: serializer.fromJson<String>(json['id']),
      voucherNo: serializer.fromJson<String?>(json['voucherNo']),
      zone: serializer.fromJson<String?>(json['zone']),
      warehouseCode: serializer.fromJson<String>(json['warehouseCode']),
      openedAt: serializer.fromJson<DateTime>(json['openedAt']),
      dataAsOf: serializer.fromJson<DateTime?>(json['dataAsOf']),
      staleCache: serializer.fromJson<bool>(json['staleCache']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'voucherNo': serializer.toJson<String?>(voucherNo),
      'zone': serializer.toJson<String?>(zone),
      'warehouseCode': serializer.toJson<String>(warehouseCode),
      'openedAt': serializer.toJson<DateTime>(openedAt),
      'dataAsOf': serializer.toJson<DateTime?>(dataAsOf),
      'staleCache': serializer.toJson<bool>(staleCache),
    };
  }

  LocalSessionData copyWith({
    String? id,
    Value<String?> voucherNo = const Value.absent(),
    Value<String?> zone = const Value.absent(),
    String? warehouseCode,
    DateTime? openedAt,
    Value<DateTime?> dataAsOf = const Value.absent(),
    bool? staleCache,
  }) => LocalSessionData(
    id: id ?? this.id,
    voucherNo: voucherNo.present ? voucherNo.value : this.voucherNo,
    zone: zone.present ? zone.value : this.zone,
    warehouseCode: warehouseCode ?? this.warehouseCode,
    openedAt: openedAt ?? this.openedAt,
    dataAsOf: dataAsOf.present ? dataAsOf.value : this.dataAsOf,
    staleCache: staleCache ?? this.staleCache,
  );
  LocalSessionData copyWithCompanion(LocalSessionCompanion data) {
    return LocalSessionData(
      id: data.id.present ? data.id.value : this.id,
      voucherNo: data.voucherNo.present ? data.voucherNo.value : this.voucherNo,
      zone: data.zone.present ? data.zone.value : this.zone,
      warehouseCode: data.warehouseCode.present
          ? data.warehouseCode.value
          : this.warehouseCode,
      openedAt: data.openedAt.present ? data.openedAt.value : this.openedAt,
      dataAsOf: data.dataAsOf.present ? data.dataAsOf.value : this.dataAsOf,
      staleCache: data.staleCache.present
          ? data.staleCache.value
          : this.staleCache,
    );
  }

  @override
  String toString() {
    return (StringBuffer('LocalSessionData(')
          ..write('id: $id, ')
          ..write('voucherNo: $voucherNo, ')
          ..write('zone: $zone, ')
          ..write('warehouseCode: $warehouseCode, ')
          ..write('openedAt: $openedAt, ')
          ..write('dataAsOf: $dataAsOf, ')
          ..write('staleCache: $staleCache')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    voucherNo,
    zone,
    warehouseCode,
    openedAt,
    dataAsOf,
    staleCache,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is LocalSessionData &&
          other.id == this.id &&
          other.voucherNo == this.voucherNo &&
          other.zone == this.zone &&
          other.warehouseCode == this.warehouseCode &&
          other.openedAt == this.openedAt &&
          other.dataAsOf == this.dataAsOf &&
          other.staleCache == this.staleCache);
}

class LocalSessionCompanion extends UpdateCompanion<LocalSessionData> {
  final Value<String> id;
  final Value<String?> voucherNo;
  final Value<String?> zone;
  final Value<String> warehouseCode;
  final Value<DateTime> openedAt;
  final Value<DateTime?> dataAsOf;
  final Value<bool> staleCache;
  final Value<int> rowid;
  const LocalSessionCompanion({
    this.id = const Value.absent(),
    this.voucherNo = const Value.absent(),
    this.zone = const Value.absent(),
    this.warehouseCode = const Value.absent(),
    this.openedAt = const Value.absent(),
    this.dataAsOf = const Value.absent(),
    this.staleCache = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  LocalSessionCompanion.insert({
    required String id,
    this.voucherNo = const Value.absent(),
    this.zone = const Value.absent(),
    required String warehouseCode,
    required DateTime openedAt,
    this.dataAsOf = const Value.absent(),
    this.staleCache = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       warehouseCode = Value(warehouseCode),
       openedAt = Value(openedAt);
  static Insertable<LocalSessionData> custom({
    Expression<String>? id,
    Expression<String>? voucherNo,
    Expression<String>? zone,
    Expression<String>? warehouseCode,
    Expression<DateTime>? openedAt,
    Expression<DateTime>? dataAsOf,
    Expression<bool>? staleCache,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (voucherNo != null) 'voucher_no': voucherNo,
      if (zone != null) 'zone': zone,
      if (warehouseCode != null) 'warehouse_code': warehouseCode,
      if (openedAt != null) 'opened_at': openedAt,
      if (dataAsOf != null) 'data_as_of': dataAsOf,
      if (staleCache != null) 'stale_cache': staleCache,
      if (rowid != null) 'rowid': rowid,
    });
  }

  LocalSessionCompanion copyWith({
    Value<String>? id,
    Value<String?>? voucherNo,
    Value<String?>? zone,
    Value<String>? warehouseCode,
    Value<DateTime>? openedAt,
    Value<DateTime?>? dataAsOf,
    Value<bool>? staleCache,
    Value<int>? rowid,
  }) {
    return LocalSessionCompanion(
      id: id ?? this.id,
      voucherNo: voucherNo ?? this.voucherNo,
      zone: zone ?? this.zone,
      warehouseCode: warehouseCode ?? this.warehouseCode,
      openedAt: openedAt ?? this.openedAt,
      dataAsOf: dataAsOf ?? this.dataAsOf,
      staleCache: staleCache ?? this.staleCache,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (voucherNo.present) {
      map['voucher_no'] = Variable<String>(voucherNo.value);
    }
    if (zone.present) {
      map['zone'] = Variable<String>(zone.value);
    }
    if (warehouseCode.present) {
      map['warehouse_code'] = Variable<String>(warehouseCode.value);
    }
    if (openedAt.present) {
      map['opened_at'] = Variable<DateTime>(openedAt.value);
    }
    if (dataAsOf.present) {
      map['data_as_of'] = Variable<DateTime>(dataAsOf.value);
    }
    if (staleCache.present) {
      map['stale_cache'] = Variable<bool>(staleCache.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('LocalSessionCompanion(')
          ..write('id: $id, ')
          ..write('voucherNo: $voucherNo, ')
          ..write('zone: $zone, ')
          ..write('warehouseCode: $warehouseCode, ')
          ..write('openedAt: $openedAt, ')
          ..write('dataAsOf: $dataAsOf, ')
          ..write('staleCache: $staleCache, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $LocalSessionRowsTable extends LocalSessionRows
    with TableInfo<$LocalSessionRowsTable, LocalSessionRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $LocalSessionRowsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _skuMeta = const VerificationMeta('sku');
  @override
  late final GeneratedColumn<String> sku = GeneratedColumn<String>(
    'sku',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _systemQtyMeta = const VerificationMeta(
    'systemQty',
  );
  @override
  late final GeneratedColumn<double> systemQty = GeneratedColumn<double>(
    'system_qty',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _unitMeta = const VerificationMeta('unit');
  @override
  late final GeneratedColumn<String> unit = GeneratedColumn<String>(
    'unit',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _locMeta = const VerificationMeta('loc');
  @override
  late final GeneratedColumn<String> loc = GeneratedColumn<String>(
    'loc',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _zoneMeta = const VerificationMeta('zone');
  @override
  late final GeneratedColumn<String> zone = GeneratedColumn<String>(
    'zone',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    sessionId,
    sku,
    name,
    systemQty,
    unit,
    loc,
    zone,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'local_session_rows';
  @override
  VerificationContext validateIntegrity(
    Insertable<LocalSessionRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('sku')) {
      context.handle(
        _skuMeta,
        sku.isAcceptableOrUnknown(data['sku']!, _skuMeta),
      );
    } else if (isInserting) {
      context.missing(_skuMeta);
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    } else if (isInserting) {
      context.missing(_nameMeta);
    }
    if (data.containsKey('system_qty')) {
      context.handle(
        _systemQtyMeta,
        systemQty.isAcceptableOrUnknown(data['system_qty']!, _systemQtyMeta),
      );
    } else if (isInserting) {
      context.missing(_systemQtyMeta);
    }
    if (data.containsKey('unit')) {
      context.handle(
        _unitMeta,
        unit.isAcceptableOrUnknown(data['unit']!, _unitMeta),
      );
    }
    if (data.containsKey('loc')) {
      context.handle(
        _locMeta,
        loc.isAcceptableOrUnknown(data['loc']!, _locMeta),
      );
    }
    if (data.containsKey('zone')) {
      context.handle(
        _zoneMeta,
        zone.isAcceptableOrUnknown(data['zone']!, _zoneMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {sessionId, sku};
  @override
  LocalSessionRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return LocalSessionRow(
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      sku: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}sku'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      systemQty: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}system_qty'],
      )!,
      unit: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}unit'],
      ),
      loc: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}loc'],
      ),
      zone: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}zone'],
      ),
    );
  }

  @override
  $LocalSessionRowsTable createAlias(String alias) {
    return $LocalSessionRowsTable(attachedDatabase, alias);
  }
}

class LocalSessionRow extends DataClass implements Insertable<LocalSessionRow> {
  final String sessionId;
  final String sku;
  final String name;

  /// ยอดตามระบบที่ freeze แล้ว — ERP ไม่ส่ง NULL จึง non-null
  final double systemQty;
  final String? unit;
  final String? loc;

  /// โซนของแถว — ปัจจุบันเก็บโซนของรอบ ([CountRow] ยังไม่มีฟิลด์ zone รายแถว)
  final String? zone;
  const LocalSessionRow({
    required this.sessionId,
    required this.sku,
    required this.name,
    required this.systemQty,
    this.unit,
    this.loc,
    this.zone,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['session_id'] = Variable<String>(sessionId);
    map['sku'] = Variable<String>(sku);
    map['name'] = Variable<String>(name);
    map['system_qty'] = Variable<double>(systemQty);
    if (!nullToAbsent || unit != null) {
      map['unit'] = Variable<String>(unit);
    }
    if (!nullToAbsent || loc != null) {
      map['loc'] = Variable<String>(loc);
    }
    if (!nullToAbsent || zone != null) {
      map['zone'] = Variable<String>(zone);
    }
    return map;
  }

  LocalSessionRowsCompanion toCompanion(bool nullToAbsent) {
    return LocalSessionRowsCompanion(
      sessionId: Value(sessionId),
      sku: Value(sku),
      name: Value(name),
      systemQty: Value(systemQty),
      unit: unit == null && nullToAbsent ? const Value.absent() : Value(unit),
      loc: loc == null && nullToAbsent ? const Value.absent() : Value(loc),
      zone: zone == null && nullToAbsent ? const Value.absent() : Value(zone),
    );
  }

  factory LocalSessionRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return LocalSessionRow(
      sessionId: serializer.fromJson<String>(json['sessionId']),
      sku: serializer.fromJson<String>(json['sku']),
      name: serializer.fromJson<String>(json['name']),
      systemQty: serializer.fromJson<double>(json['systemQty']),
      unit: serializer.fromJson<String?>(json['unit']),
      loc: serializer.fromJson<String?>(json['loc']),
      zone: serializer.fromJson<String?>(json['zone']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'sessionId': serializer.toJson<String>(sessionId),
      'sku': serializer.toJson<String>(sku),
      'name': serializer.toJson<String>(name),
      'systemQty': serializer.toJson<double>(systemQty),
      'unit': serializer.toJson<String?>(unit),
      'loc': serializer.toJson<String?>(loc),
      'zone': serializer.toJson<String?>(zone),
    };
  }

  LocalSessionRow copyWith({
    String? sessionId,
    String? sku,
    String? name,
    double? systemQty,
    Value<String?> unit = const Value.absent(),
    Value<String?> loc = const Value.absent(),
    Value<String?> zone = const Value.absent(),
  }) => LocalSessionRow(
    sessionId: sessionId ?? this.sessionId,
    sku: sku ?? this.sku,
    name: name ?? this.name,
    systemQty: systemQty ?? this.systemQty,
    unit: unit.present ? unit.value : this.unit,
    loc: loc.present ? loc.value : this.loc,
    zone: zone.present ? zone.value : this.zone,
  );
  LocalSessionRow copyWithCompanion(LocalSessionRowsCompanion data) {
    return LocalSessionRow(
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      sku: data.sku.present ? data.sku.value : this.sku,
      name: data.name.present ? data.name.value : this.name,
      systemQty: data.systemQty.present ? data.systemQty.value : this.systemQty,
      unit: data.unit.present ? data.unit.value : this.unit,
      loc: data.loc.present ? data.loc.value : this.loc,
      zone: data.zone.present ? data.zone.value : this.zone,
    );
  }

  @override
  String toString() {
    return (StringBuffer('LocalSessionRow(')
          ..write('sessionId: $sessionId, ')
          ..write('sku: $sku, ')
          ..write('name: $name, ')
          ..write('systemQty: $systemQty, ')
          ..write('unit: $unit, ')
          ..write('loc: $loc, ')
          ..write('zone: $zone')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(sessionId, sku, name, systemQty, unit, loc, zone);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is LocalSessionRow &&
          other.sessionId == this.sessionId &&
          other.sku == this.sku &&
          other.name == this.name &&
          other.systemQty == this.systemQty &&
          other.unit == this.unit &&
          other.loc == this.loc &&
          other.zone == this.zone);
}

class LocalSessionRowsCompanion extends UpdateCompanion<LocalSessionRow> {
  final Value<String> sessionId;
  final Value<String> sku;
  final Value<String> name;
  final Value<double> systemQty;
  final Value<String?> unit;
  final Value<String?> loc;
  final Value<String?> zone;
  final Value<int> rowid;
  const LocalSessionRowsCompanion({
    this.sessionId = const Value.absent(),
    this.sku = const Value.absent(),
    this.name = const Value.absent(),
    this.systemQty = const Value.absent(),
    this.unit = const Value.absent(),
    this.loc = const Value.absent(),
    this.zone = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  LocalSessionRowsCompanion.insert({
    required String sessionId,
    required String sku,
    required String name,
    required double systemQty,
    this.unit = const Value.absent(),
    this.loc = const Value.absent(),
    this.zone = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : sessionId = Value(sessionId),
       sku = Value(sku),
       name = Value(name),
       systemQty = Value(systemQty);
  static Insertable<LocalSessionRow> custom({
    Expression<String>? sessionId,
    Expression<String>? sku,
    Expression<String>? name,
    Expression<double>? systemQty,
    Expression<String>? unit,
    Expression<String>? loc,
    Expression<String>? zone,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (sessionId != null) 'session_id': sessionId,
      if (sku != null) 'sku': sku,
      if (name != null) 'name': name,
      if (systemQty != null) 'system_qty': systemQty,
      if (unit != null) 'unit': unit,
      if (loc != null) 'loc': loc,
      if (zone != null) 'zone': zone,
      if (rowid != null) 'rowid': rowid,
    });
  }

  LocalSessionRowsCompanion copyWith({
    Value<String>? sessionId,
    Value<String>? sku,
    Value<String>? name,
    Value<double>? systemQty,
    Value<String?>? unit,
    Value<String?>? loc,
    Value<String?>? zone,
    Value<int>? rowid,
  }) {
    return LocalSessionRowsCompanion(
      sessionId: sessionId ?? this.sessionId,
      sku: sku ?? this.sku,
      name: name ?? this.name,
      systemQty: systemQty ?? this.systemQty,
      unit: unit ?? this.unit,
      loc: loc ?? this.loc,
      zone: zone ?? this.zone,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (sku.present) {
      map['sku'] = Variable<String>(sku.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (systemQty.present) {
      map['system_qty'] = Variable<double>(systemQty.value);
    }
    if (unit.present) {
      map['unit'] = Variable<String>(unit.value);
    }
    if (loc.present) {
      map['loc'] = Variable<String>(loc.value);
    }
    if (zone.present) {
      map['zone'] = Variable<String>(zone.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('LocalSessionRowsCompanion(')
          ..write('sessionId: $sessionId, ')
          ..write('sku: $sku, ')
          ..write('name: $name, ')
          ..write('systemQty: $systemQty, ')
          ..write('unit: $unit, ')
          ..write('loc: $loc, ')
          ..write('zone: $zone, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $OutboxTable extends Outbox with TableInfo<$OutboxTable, OutboxRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $OutboxTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _typeMeta = const VerificationMeta('type');
  @override
  late final GeneratedColumn<String> type = GeneratedColumn<String>(
    'type',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _skuMeta = const VerificationMeta('sku');
  @override
  late final GeneratedColumn<String> sku = GeneratedColumn<String>(
    'sku',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _payloadJsonMeta = const VerificationMeta(
    'payloadJson',
  );
  @override
  late final GeneratedColumn<String> payloadJson = GeneratedColumn<String>(
    'payload_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _deviceSeqMeta = const VerificationMeta(
    'deviceSeq',
  );
  @override
  late final GeneratedColumn<int> deviceSeq = GeneratedColumn<int>(
    'device_seq',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('queued'),
  );
  static const VerificationMeta _attemptsMeta = const VerificationMeta(
    'attempts',
  );
  @override
  late final GeneratedColumn<int> attempts = GeneratedColumn<int>(
    'attempts',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _nextRetryAtMeta = const VerificationMeta(
    'nextRetryAt',
  );
  @override
  late final GeneratedColumn<DateTime> nextRetryAt = GeneratedColumn<DateTime>(
    'next_retry_at',
    aliasedName,
    true,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lastErrorMeta = const VerificationMeta(
    'lastError',
  );
  @override
  late final GeneratedColumn<String> lastError = GeneratedColumn<String>(
    'last_error',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _rejectCodeMeta = const VerificationMeta(
    'rejectCode',
  );
  @override
  late final GeneratedColumn<String> rejectCode = GeneratedColumn<String>(
    'reject_code',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    type,
    sessionId,
    sku,
    payloadJson,
    deviceSeq,
    createdAt,
    status,
    attempts,
    nextRetryAt,
    lastError,
    rejectCode,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'outbox';
  @override
  VerificationContext validateIntegrity(
    Insertable<OutboxRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('type')) {
      context.handle(
        _typeMeta,
        type.isAcceptableOrUnknown(data['type']!, _typeMeta),
      );
    } else if (isInserting) {
      context.missing(_typeMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    }
    if (data.containsKey('sku')) {
      context.handle(
        _skuMeta,
        sku.isAcceptableOrUnknown(data['sku']!, _skuMeta),
      );
    }
    if (data.containsKey('payload_json')) {
      context.handle(
        _payloadJsonMeta,
        payloadJson.isAcceptableOrUnknown(
          data['payload_json']!,
          _payloadJsonMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_payloadJsonMeta);
    }
    if (data.containsKey('device_seq')) {
      context.handle(
        _deviceSeqMeta,
        deviceSeq.isAcceptableOrUnknown(data['device_seq']!, _deviceSeqMeta),
      );
    } else if (isInserting) {
      context.missing(_deviceSeqMeta);
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    }
    if (data.containsKey('attempts')) {
      context.handle(
        _attemptsMeta,
        attempts.isAcceptableOrUnknown(data['attempts']!, _attemptsMeta),
      );
    }
    if (data.containsKey('next_retry_at')) {
      context.handle(
        _nextRetryAtMeta,
        nextRetryAt.isAcceptableOrUnknown(
          data['next_retry_at']!,
          _nextRetryAtMeta,
        ),
      );
    }
    if (data.containsKey('last_error')) {
      context.handle(
        _lastErrorMeta,
        lastError.isAcceptableOrUnknown(data['last_error']!, _lastErrorMeta),
      );
    }
    if (data.containsKey('reject_code')) {
      context.handle(
        _rejectCodeMeta,
        rejectCode.isAcceptableOrUnknown(data['reject_code']!, _rejectCodeMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  OutboxRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return OutboxRow(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      type: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}type'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      ),
      sku: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}sku'],
      ),
      payloadJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payload_json'],
      )!,
      deviceSeq: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}device_seq'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      attempts: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}attempts'],
      )!,
      nextRetryAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}next_retry_at'],
      ),
      lastError: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}last_error'],
      ),
      rejectCode: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}reject_code'],
      ),
    );
  }

  @override
  $OutboxTable createAlias(String alias) {
    return $OutboxTable(attachedDatabase, alias);
  }
}

class OutboxRow extends DataClass implements Insertable<OutboxRow> {
  final String id;

  /// ดู [OutboxType]
  final String type;
  final String? sessionId;
  final String? sku;

  /// body ที่พร้อมส่งขึ้น server (JSON object)
  final String payloadJson;

  /// ลำดับการนับจริงของเครื่องนี้ — monotonic, ไม่พึ่งนาฬิกา
  final int deviceSeq;
  final DateTime createdAt;

  /// ดู [OutboxStatus] — literal ต้องตรงกับ `OutboxStatus.queued`
  /// (เขียนตรง ๆ เพราะ `withDefault` ต้องเป็น const ที่ drift_dev อ่านออก)
  final String status;
  final int attempts;

  /// null = ส่งได้ทันที · มีค่า = รอ backoff
  final DateTime? nextRetryAt;

  /// ข้อความ error ล่าสุดแบบย่อ (เพื่อ debug — ไม่ใส่ข้อมูลผู้ใช้)
  final String? lastError;

  /// **มีค่า = terminal**: server ปฏิเสธ (เช่น `SESSION_CLOSED` / `ROLE_CHANGED`)
  /// → หลุดจากวงจร retry ไปรออยู่จอ pending-review
  final String? rejectCode;
  const OutboxRow({
    required this.id,
    required this.type,
    this.sessionId,
    this.sku,
    required this.payloadJson,
    required this.deviceSeq,
    required this.createdAt,
    required this.status,
    required this.attempts,
    this.nextRetryAt,
    this.lastError,
    this.rejectCode,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['type'] = Variable<String>(type);
    if (!nullToAbsent || sessionId != null) {
      map['session_id'] = Variable<String>(sessionId);
    }
    if (!nullToAbsent || sku != null) {
      map['sku'] = Variable<String>(sku);
    }
    map['payload_json'] = Variable<String>(payloadJson);
    map['device_seq'] = Variable<int>(deviceSeq);
    map['created_at'] = Variable<DateTime>(createdAt);
    map['status'] = Variable<String>(status);
    map['attempts'] = Variable<int>(attempts);
    if (!nullToAbsent || nextRetryAt != null) {
      map['next_retry_at'] = Variable<DateTime>(nextRetryAt);
    }
    if (!nullToAbsent || lastError != null) {
      map['last_error'] = Variable<String>(lastError);
    }
    if (!nullToAbsent || rejectCode != null) {
      map['reject_code'] = Variable<String>(rejectCode);
    }
    return map;
  }

  OutboxCompanion toCompanion(bool nullToAbsent) {
    return OutboxCompanion(
      id: Value(id),
      type: Value(type),
      sessionId: sessionId == null && nullToAbsent
          ? const Value.absent()
          : Value(sessionId),
      sku: sku == null && nullToAbsent ? const Value.absent() : Value(sku),
      payloadJson: Value(payloadJson),
      deviceSeq: Value(deviceSeq),
      createdAt: Value(createdAt),
      status: Value(status),
      attempts: Value(attempts),
      nextRetryAt: nextRetryAt == null && nullToAbsent
          ? const Value.absent()
          : Value(nextRetryAt),
      lastError: lastError == null && nullToAbsent
          ? const Value.absent()
          : Value(lastError),
      rejectCode: rejectCode == null && nullToAbsent
          ? const Value.absent()
          : Value(rejectCode),
    );
  }

  factory OutboxRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return OutboxRow(
      id: serializer.fromJson<String>(json['id']),
      type: serializer.fromJson<String>(json['type']),
      sessionId: serializer.fromJson<String?>(json['sessionId']),
      sku: serializer.fromJson<String?>(json['sku']),
      payloadJson: serializer.fromJson<String>(json['payloadJson']),
      deviceSeq: serializer.fromJson<int>(json['deviceSeq']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      status: serializer.fromJson<String>(json['status']),
      attempts: serializer.fromJson<int>(json['attempts']),
      nextRetryAt: serializer.fromJson<DateTime?>(json['nextRetryAt']),
      lastError: serializer.fromJson<String?>(json['lastError']),
      rejectCode: serializer.fromJson<String?>(json['rejectCode']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'type': serializer.toJson<String>(type),
      'sessionId': serializer.toJson<String?>(sessionId),
      'sku': serializer.toJson<String?>(sku),
      'payloadJson': serializer.toJson<String>(payloadJson),
      'deviceSeq': serializer.toJson<int>(deviceSeq),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'status': serializer.toJson<String>(status),
      'attempts': serializer.toJson<int>(attempts),
      'nextRetryAt': serializer.toJson<DateTime?>(nextRetryAt),
      'lastError': serializer.toJson<String?>(lastError),
      'rejectCode': serializer.toJson<String?>(rejectCode),
    };
  }

  OutboxRow copyWith({
    String? id,
    String? type,
    Value<String?> sessionId = const Value.absent(),
    Value<String?> sku = const Value.absent(),
    String? payloadJson,
    int? deviceSeq,
    DateTime? createdAt,
    String? status,
    int? attempts,
    Value<DateTime?> nextRetryAt = const Value.absent(),
    Value<String?> lastError = const Value.absent(),
    Value<String?> rejectCode = const Value.absent(),
  }) => OutboxRow(
    id: id ?? this.id,
    type: type ?? this.type,
    sessionId: sessionId.present ? sessionId.value : this.sessionId,
    sku: sku.present ? sku.value : this.sku,
    payloadJson: payloadJson ?? this.payloadJson,
    deviceSeq: deviceSeq ?? this.deviceSeq,
    createdAt: createdAt ?? this.createdAt,
    status: status ?? this.status,
    attempts: attempts ?? this.attempts,
    nextRetryAt: nextRetryAt.present ? nextRetryAt.value : this.nextRetryAt,
    lastError: lastError.present ? lastError.value : this.lastError,
    rejectCode: rejectCode.present ? rejectCode.value : this.rejectCode,
  );
  OutboxRow copyWithCompanion(OutboxCompanion data) {
    return OutboxRow(
      id: data.id.present ? data.id.value : this.id,
      type: data.type.present ? data.type.value : this.type,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      sku: data.sku.present ? data.sku.value : this.sku,
      payloadJson: data.payloadJson.present
          ? data.payloadJson.value
          : this.payloadJson,
      deviceSeq: data.deviceSeq.present ? data.deviceSeq.value : this.deviceSeq,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      status: data.status.present ? data.status.value : this.status,
      attempts: data.attempts.present ? data.attempts.value : this.attempts,
      nextRetryAt: data.nextRetryAt.present
          ? data.nextRetryAt.value
          : this.nextRetryAt,
      lastError: data.lastError.present ? data.lastError.value : this.lastError,
      rejectCode: data.rejectCode.present
          ? data.rejectCode.value
          : this.rejectCode,
    );
  }

  @override
  String toString() {
    return (StringBuffer('OutboxRow(')
          ..write('id: $id, ')
          ..write('type: $type, ')
          ..write('sessionId: $sessionId, ')
          ..write('sku: $sku, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('deviceSeq: $deviceSeq, ')
          ..write('createdAt: $createdAt, ')
          ..write('status: $status, ')
          ..write('attempts: $attempts, ')
          ..write('nextRetryAt: $nextRetryAt, ')
          ..write('lastError: $lastError, ')
          ..write('rejectCode: $rejectCode')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    type,
    sessionId,
    sku,
    payloadJson,
    deviceSeq,
    createdAt,
    status,
    attempts,
    nextRetryAt,
    lastError,
    rejectCode,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is OutboxRow &&
          other.id == this.id &&
          other.type == this.type &&
          other.sessionId == this.sessionId &&
          other.sku == this.sku &&
          other.payloadJson == this.payloadJson &&
          other.deviceSeq == this.deviceSeq &&
          other.createdAt == this.createdAt &&
          other.status == this.status &&
          other.attempts == this.attempts &&
          other.nextRetryAt == this.nextRetryAt &&
          other.lastError == this.lastError &&
          other.rejectCode == this.rejectCode);
}

class OutboxCompanion extends UpdateCompanion<OutboxRow> {
  final Value<String> id;
  final Value<String> type;
  final Value<String?> sessionId;
  final Value<String?> sku;
  final Value<String> payloadJson;
  final Value<int> deviceSeq;
  final Value<DateTime> createdAt;
  final Value<String> status;
  final Value<int> attempts;
  final Value<DateTime?> nextRetryAt;
  final Value<String?> lastError;
  final Value<String?> rejectCode;
  final Value<int> rowid;
  const OutboxCompanion({
    this.id = const Value.absent(),
    this.type = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.sku = const Value.absent(),
    this.payloadJson = const Value.absent(),
    this.deviceSeq = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.status = const Value.absent(),
    this.attempts = const Value.absent(),
    this.nextRetryAt = const Value.absent(),
    this.lastError = const Value.absent(),
    this.rejectCode = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  OutboxCompanion.insert({
    required String id,
    required String type,
    this.sessionId = const Value.absent(),
    this.sku = const Value.absent(),
    required String payloadJson,
    required int deviceSeq,
    required DateTime createdAt,
    this.status = const Value.absent(),
    this.attempts = const Value.absent(),
    this.nextRetryAt = const Value.absent(),
    this.lastError = const Value.absent(),
    this.rejectCode = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       type = Value(type),
       payloadJson = Value(payloadJson),
       deviceSeq = Value(deviceSeq),
       createdAt = Value(createdAt);
  static Insertable<OutboxRow> custom({
    Expression<String>? id,
    Expression<String>? type,
    Expression<String>? sessionId,
    Expression<String>? sku,
    Expression<String>? payloadJson,
    Expression<int>? deviceSeq,
    Expression<DateTime>? createdAt,
    Expression<String>? status,
    Expression<int>? attempts,
    Expression<DateTime>? nextRetryAt,
    Expression<String>? lastError,
    Expression<String>? rejectCode,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (type != null) 'type': type,
      if (sessionId != null) 'session_id': sessionId,
      if (sku != null) 'sku': sku,
      if (payloadJson != null) 'payload_json': payloadJson,
      if (deviceSeq != null) 'device_seq': deviceSeq,
      if (createdAt != null) 'created_at': createdAt,
      if (status != null) 'status': status,
      if (attempts != null) 'attempts': attempts,
      if (nextRetryAt != null) 'next_retry_at': nextRetryAt,
      if (lastError != null) 'last_error': lastError,
      if (rejectCode != null) 'reject_code': rejectCode,
      if (rowid != null) 'rowid': rowid,
    });
  }

  OutboxCompanion copyWith({
    Value<String>? id,
    Value<String>? type,
    Value<String?>? sessionId,
    Value<String?>? sku,
    Value<String>? payloadJson,
    Value<int>? deviceSeq,
    Value<DateTime>? createdAt,
    Value<String>? status,
    Value<int>? attempts,
    Value<DateTime?>? nextRetryAt,
    Value<String?>? lastError,
    Value<String?>? rejectCode,
    Value<int>? rowid,
  }) {
    return OutboxCompanion(
      id: id ?? this.id,
      type: type ?? this.type,
      sessionId: sessionId ?? this.sessionId,
      sku: sku ?? this.sku,
      payloadJson: payloadJson ?? this.payloadJson,
      deviceSeq: deviceSeq ?? this.deviceSeq,
      createdAt: createdAt ?? this.createdAt,
      status: status ?? this.status,
      attempts: attempts ?? this.attempts,
      nextRetryAt: nextRetryAt ?? this.nextRetryAt,
      lastError: lastError ?? this.lastError,
      rejectCode: rejectCode ?? this.rejectCode,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (type.present) {
      map['type'] = Variable<String>(type.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (sku.present) {
      map['sku'] = Variable<String>(sku.value);
    }
    if (payloadJson.present) {
      map['payload_json'] = Variable<String>(payloadJson.value);
    }
    if (deviceSeq.present) {
      map['device_seq'] = Variable<int>(deviceSeq.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (attempts.present) {
      map['attempts'] = Variable<int>(attempts.value);
    }
    if (nextRetryAt.present) {
      map['next_retry_at'] = Variable<DateTime>(nextRetryAt.value);
    }
    if (lastError.present) {
      map['last_error'] = Variable<String>(lastError.value);
    }
    if (rejectCode.present) {
      map['reject_code'] = Variable<String>(rejectCode.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('OutboxCompanion(')
          ..write('id: $id, ')
          ..write('type: $type, ')
          ..write('sessionId: $sessionId, ')
          ..write('sku: $sku, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('deviceSeq: $deviceSeq, ')
          ..write('createdAt: $createdAt, ')
          ..write('status: $status, ')
          ..write('attempts: $attempts, ')
          ..write('nextRetryAt: $nextRetryAt, ')
          ..write('lastError: $lastError, ')
          ..write('rejectCode: $rejectCode, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $KvMetaTable extends KvMeta with TableInfo<$KvMetaTable, KvMetaRow> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $KvMetaTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _keyMeta = const VerificationMeta('key');
  @override
  late final GeneratedColumn<String> key = GeneratedColumn<String>(
    'key',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _valueMeta = const VerificationMeta('value');
  @override
  late final GeneratedColumn<String> value = GeneratedColumn<String>(
    'value',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [key, value];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'kv_meta';
  @override
  VerificationContext validateIntegrity(
    Insertable<KvMetaRow> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('key')) {
      context.handle(
        _keyMeta,
        key.isAcceptableOrUnknown(data['key']!, _keyMeta),
      );
    } else if (isInserting) {
      context.missing(_keyMeta);
    }
    if (data.containsKey('value')) {
      context.handle(
        _valueMeta,
        value.isAcceptableOrUnknown(data['value']!, _valueMeta),
      );
    } else if (isInserting) {
      context.missing(_valueMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {key};
  @override
  KvMetaRow map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return KvMetaRow(
      key: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}key'],
      )!,
      value: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}value'],
      )!,
    );
  }

  @override
  $KvMetaTable createAlias(String alias) {
    return $KvMetaTable(attachedDatabase, alias);
  }
}

class KvMetaRow extends DataClass implements Insertable<KvMetaRow> {
  final String key;
  final String value;
  const KvMetaRow({required this.key, required this.value});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['key'] = Variable<String>(key);
    map['value'] = Variable<String>(value);
    return map;
  }

  KvMetaCompanion toCompanion(bool nullToAbsent) {
    return KvMetaCompanion(key: Value(key), value: Value(value));
  }

  factory KvMetaRow.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return KvMetaRow(
      key: serializer.fromJson<String>(json['key']),
      value: serializer.fromJson<String>(json['value']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'key': serializer.toJson<String>(key),
      'value': serializer.toJson<String>(value),
    };
  }

  KvMetaRow copyWith({String? key, String? value}) =>
      KvMetaRow(key: key ?? this.key, value: value ?? this.value);
  KvMetaRow copyWithCompanion(KvMetaCompanion data) {
    return KvMetaRow(
      key: data.key.present ? data.key.value : this.key,
      value: data.value.present ? data.value.value : this.value,
    );
  }

  @override
  String toString() {
    return (StringBuffer('KvMetaRow(')
          ..write('key: $key, ')
          ..write('value: $value')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(key, value);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is KvMetaRow &&
          other.key == this.key &&
          other.value == this.value);
}

class KvMetaCompanion extends UpdateCompanion<KvMetaRow> {
  final Value<String> key;
  final Value<String> value;
  final Value<int> rowid;
  const KvMetaCompanion({
    this.key = const Value.absent(),
    this.value = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  KvMetaCompanion.insert({
    required String key,
    required String value,
    this.rowid = const Value.absent(),
  }) : key = Value(key),
       value = Value(value);
  static Insertable<KvMetaRow> custom({
    Expression<String>? key,
    Expression<String>? value,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (key != null) 'key': key,
      if (value != null) 'value': value,
      if (rowid != null) 'rowid': rowid,
    });
  }

  KvMetaCompanion copyWith({
    Value<String>? key,
    Value<String>? value,
    Value<int>? rowid,
  }) {
    return KvMetaCompanion(
      key: key ?? this.key,
      value: value ?? this.value,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (key.present) {
      map['key'] = Variable<String>(key.value);
    }
    if (value.present) {
      map['value'] = Variable<String>(value.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('KvMetaCompanion(')
          ..write('key: $key, ')
          ..write('value: $value, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

abstract class _$LocalDb extends GeneratedDatabase {
  _$LocalDb(QueryExecutor e) : super(e);
  $LocalDbManager get managers => $LocalDbManager(this);
  late final $LocalItemsTable localItems = $LocalItemsTable(this);
  late final $LocalBarcodesTable localBarcodes = $LocalBarcodesTable(this);
  late final $LocalMembersTable localMembers = $LocalMembersTable(this);
  late final $LocalSessionTable localSession = $LocalSessionTable(this);
  late final $LocalSessionRowsTable localSessionRows = $LocalSessionRowsTable(
    this,
  );
  late final $OutboxTable outbox = $OutboxTable(this);
  late final $KvMetaTable kvMeta = $KvMetaTable(this);
  late final Index idxLocalBarcodesSku = Index(
    'idx_local_barcodes_sku',
    'CREATE INDEX idx_local_barcodes_sku ON local_barcodes (sku)',
  );
  late final Index idxOutboxDue = Index(
    'idx_outbox_due',
    'CREATE INDEX idx_outbox_due ON outbox (status, next_retry_at)',
  );
  late final Index idxOutboxSessionSku = Index(
    'idx_outbox_session_sku',
    'CREATE INDEX idx_outbox_session_sku ON outbox (session_id, sku)',
  );
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [
    localItems,
    localBarcodes,
    localMembers,
    localSession,
    localSessionRows,
    outbox,
    kvMeta,
    idxLocalBarcodesSku,
    idxOutboxDue,
    idxOutboxSessionSku,
  ];
}

typedef $$LocalItemsTableCreateCompanionBuilder =
    LocalItemsCompanion Function({
      required String sku,
      required String name,
      Value<String?> nameEn,
      Value<String?> loc,
      Value<String?> unit,
      Value<double?> onHand,
      Value<double?> reserved,
      Value<double?> rop,
      Value<String> specsJson,
      required String warehouseCode,
      required String rowVersion,
      required DateTime updatedAt,
      Value<int> rowid,
    });
typedef $$LocalItemsTableUpdateCompanionBuilder =
    LocalItemsCompanion Function({
      Value<String> sku,
      Value<String> name,
      Value<String?> nameEn,
      Value<String?> loc,
      Value<String?> unit,
      Value<double?> onHand,
      Value<double?> reserved,
      Value<double?> rop,
      Value<String> specsJson,
      Value<String> warehouseCode,
      Value<String> rowVersion,
      Value<DateTime> updatedAt,
      Value<int> rowid,
    });

class $$LocalItemsTableFilterComposer
    extends Composer<_$LocalDb, $LocalItemsTable> {
  $$LocalItemsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get sku => $composableBuilder(
    column: $table.sku,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get nameEn => $composableBuilder(
    column: $table.nameEn,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get loc => $composableBuilder(
    column: $table.loc,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get unit => $composableBuilder(
    column: $table.unit,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get onHand => $composableBuilder(
    column: $table.onHand,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get reserved => $composableBuilder(
    column: $table.reserved,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get rop => $composableBuilder(
    column: $table.rop,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get specsJson => $composableBuilder(
    column: $table.specsJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get warehouseCode => $composableBuilder(
    column: $table.warehouseCode,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get rowVersion => $composableBuilder(
    column: $table.rowVersion,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$LocalItemsTableOrderingComposer
    extends Composer<_$LocalDb, $LocalItemsTable> {
  $$LocalItemsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get sku => $composableBuilder(
    column: $table.sku,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get nameEn => $composableBuilder(
    column: $table.nameEn,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get loc => $composableBuilder(
    column: $table.loc,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get unit => $composableBuilder(
    column: $table.unit,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get onHand => $composableBuilder(
    column: $table.onHand,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get reserved => $composableBuilder(
    column: $table.reserved,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get rop => $composableBuilder(
    column: $table.rop,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get specsJson => $composableBuilder(
    column: $table.specsJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get warehouseCode => $composableBuilder(
    column: $table.warehouseCode,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get rowVersion => $composableBuilder(
    column: $table.rowVersion,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$LocalItemsTableAnnotationComposer
    extends Composer<_$LocalDb, $LocalItemsTable> {
  $$LocalItemsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get sku =>
      $composableBuilder(column: $table.sku, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get nameEn =>
      $composableBuilder(column: $table.nameEn, builder: (column) => column);

  GeneratedColumn<String> get loc =>
      $composableBuilder(column: $table.loc, builder: (column) => column);

  GeneratedColumn<String> get unit =>
      $composableBuilder(column: $table.unit, builder: (column) => column);

  GeneratedColumn<double> get onHand =>
      $composableBuilder(column: $table.onHand, builder: (column) => column);

  GeneratedColumn<double> get reserved =>
      $composableBuilder(column: $table.reserved, builder: (column) => column);

  GeneratedColumn<double> get rop =>
      $composableBuilder(column: $table.rop, builder: (column) => column);

  GeneratedColumn<String> get specsJson =>
      $composableBuilder(column: $table.specsJson, builder: (column) => column);

  GeneratedColumn<String> get warehouseCode => $composableBuilder(
    column: $table.warehouseCode,
    builder: (column) => column,
  );

  GeneratedColumn<String> get rowVersion => $composableBuilder(
    column: $table.rowVersion,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$LocalItemsTableTableManager
    extends
        RootTableManager<
          _$LocalDb,
          $LocalItemsTable,
          LocalItem,
          $$LocalItemsTableFilterComposer,
          $$LocalItemsTableOrderingComposer,
          $$LocalItemsTableAnnotationComposer,
          $$LocalItemsTableCreateCompanionBuilder,
          $$LocalItemsTableUpdateCompanionBuilder,
          (LocalItem, BaseReferences<_$LocalDb, $LocalItemsTable, LocalItem>),
          LocalItem,
          PrefetchHooks Function()
        > {
  $$LocalItemsTableTableManager(_$LocalDb db, $LocalItemsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$LocalItemsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$LocalItemsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$LocalItemsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> sku = const Value.absent(),
                Value<String> name = const Value.absent(),
                Value<String?> nameEn = const Value.absent(),
                Value<String?> loc = const Value.absent(),
                Value<String?> unit = const Value.absent(),
                Value<double?> onHand = const Value.absent(),
                Value<double?> reserved = const Value.absent(),
                Value<double?> rop = const Value.absent(),
                Value<String> specsJson = const Value.absent(),
                Value<String> warehouseCode = const Value.absent(),
                Value<String> rowVersion = const Value.absent(),
                Value<DateTime> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => LocalItemsCompanion(
                sku: sku,
                name: name,
                nameEn: nameEn,
                loc: loc,
                unit: unit,
                onHand: onHand,
                reserved: reserved,
                rop: rop,
                specsJson: specsJson,
                warehouseCode: warehouseCode,
                rowVersion: rowVersion,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String sku,
                required String name,
                Value<String?> nameEn = const Value.absent(),
                Value<String?> loc = const Value.absent(),
                Value<String?> unit = const Value.absent(),
                Value<double?> onHand = const Value.absent(),
                Value<double?> reserved = const Value.absent(),
                Value<double?> rop = const Value.absent(),
                Value<String> specsJson = const Value.absent(),
                required String warehouseCode,
                required String rowVersion,
                required DateTime updatedAt,
                Value<int> rowid = const Value.absent(),
              }) => LocalItemsCompanion.insert(
                sku: sku,
                name: name,
                nameEn: nameEn,
                loc: loc,
                unit: unit,
                onHand: onHand,
                reserved: reserved,
                rop: rop,
                specsJson: specsJson,
                warehouseCode: warehouseCode,
                rowVersion: rowVersion,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$LocalItemsTableProcessedTableManager =
    ProcessedTableManager<
      _$LocalDb,
      $LocalItemsTable,
      LocalItem,
      $$LocalItemsTableFilterComposer,
      $$LocalItemsTableOrderingComposer,
      $$LocalItemsTableAnnotationComposer,
      $$LocalItemsTableCreateCompanionBuilder,
      $$LocalItemsTableUpdateCompanionBuilder,
      (LocalItem, BaseReferences<_$LocalDb, $LocalItemsTable, LocalItem>),
      LocalItem,
      PrefetchHooks Function()
    >;
typedef $$LocalBarcodesTableCreateCompanionBuilder =
    LocalBarcodesCompanion Function({
      required String barcode,
      required String sku,
      Value<int> rowid,
    });
typedef $$LocalBarcodesTableUpdateCompanionBuilder =
    LocalBarcodesCompanion Function({
      Value<String> barcode,
      Value<String> sku,
      Value<int> rowid,
    });

class $$LocalBarcodesTableFilterComposer
    extends Composer<_$LocalDb, $LocalBarcodesTable> {
  $$LocalBarcodesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get barcode => $composableBuilder(
    column: $table.barcode,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sku => $composableBuilder(
    column: $table.sku,
    builder: (column) => ColumnFilters(column),
  );
}

class $$LocalBarcodesTableOrderingComposer
    extends Composer<_$LocalDb, $LocalBarcodesTable> {
  $$LocalBarcodesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get barcode => $composableBuilder(
    column: $table.barcode,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sku => $composableBuilder(
    column: $table.sku,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$LocalBarcodesTableAnnotationComposer
    extends Composer<_$LocalDb, $LocalBarcodesTable> {
  $$LocalBarcodesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get barcode =>
      $composableBuilder(column: $table.barcode, builder: (column) => column);

  GeneratedColumn<String> get sku =>
      $composableBuilder(column: $table.sku, builder: (column) => column);
}

class $$LocalBarcodesTableTableManager
    extends
        RootTableManager<
          _$LocalDb,
          $LocalBarcodesTable,
          LocalBarcode,
          $$LocalBarcodesTableFilterComposer,
          $$LocalBarcodesTableOrderingComposer,
          $$LocalBarcodesTableAnnotationComposer,
          $$LocalBarcodesTableCreateCompanionBuilder,
          $$LocalBarcodesTableUpdateCompanionBuilder,
          (
            LocalBarcode,
            BaseReferences<_$LocalDb, $LocalBarcodesTable, LocalBarcode>,
          ),
          LocalBarcode,
          PrefetchHooks Function()
        > {
  $$LocalBarcodesTableTableManager(_$LocalDb db, $LocalBarcodesTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$LocalBarcodesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$LocalBarcodesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$LocalBarcodesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> barcode = const Value.absent(),
                Value<String> sku = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => LocalBarcodesCompanion(
                barcode: barcode,
                sku: sku,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String barcode,
                required String sku,
                Value<int> rowid = const Value.absent(),
              }) => LocalBarcodesCompanion.insert(
                barcode: barcode,
                sku: sku,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$LocalBarcodesTableProcessedTableManager =
    ProcessedTableManager<
      _$LocalDb,
      $LocalBarcodesTable,
      LocalBarcode,
      $$LocalBarcodesTableFilterComposer,
      $$LocalBarcodesTableOrderingComposer,
      $$LocalBarcodesTableAnnotationComposer,
      $$LocalBarcodesTableCreateCompanionBuilder,
      $$LocalBarcodesTableUpdateCompanionBuilder,
      (
        LocalBarcode,
        BaseReferences<_$LocalDb, $LocalBarcodesTable, LocalBarcode>,
      ),
      LocalBarcode,
      PrefetchHooks Function()
    >;
typedef $$LocalMembersTableCreateCompanionBuilder =
    LocalMembersCompanion Function({
      required String empId,
      required String name,
      required String shift,
      required String role,
      Value<int> rowid,
    });
typedef $$LocalMembersTableUpdateCompanionBuilder =
    LocalMembersCompanion Function({
      Value<String> empId,
      Value<String> name,
      Value<String> shift,
      Value<String> role,
      Value<int> rowid,
    });

class $$LocalMembersTableFilterComposer
    extends Composer<_$LocalDb, $LocalMembersTable> {
  $$LocalMembersTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get empId => $composableBuilder(
    column: $table.empId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get shift => $composableBuilder(
    column: $table.shift,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get role => $composableBuilder(
    column: $table.role,
    builder: (column) => ColumnFilters(column),
  );
}

class $$LocalMembersTableOrderingComposer
    extends Composer<_$LocalDb, $LocalMembersTable> {
  $$LocalMembersTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get empId => $composableBuilder(
    column: $table.empId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get shift => $composableBuilder(
    column: $table.shift,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get role => $composableBuilder(
    column: $table.role,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$LocalMembersTableAnnotationComposer
    extends Composer<_$LocalDb, $LocalMembersTable> {
  $$LocalMembersTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get empId =>
      $composableBuilder(column: $table.empId, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get shift =>
      $composableBuilder(column: $table.shift, builder: (column) => column);

  GeneratedColumn<String> get role =>
      $composableBuilder(column: $table.role, builder: (column) => column);
}

class $$LocalMembersTableTableManager
    extends
        RootTableManager<
          _$LocalDb,
          $LocalMembersTable,
          LocalMember,
          $$LocalMembersTableFilterComposer,
          $$LocalMembersTableOrderingComposer,
          $$LocalMembersTableAnnotationComposer,
          $$LocalMembersTableCreateCompanionBuilder,
          $$LocalMembersTableUpdateCompanionBuilder,
          (
            LocalMember,
            BaseReferences<_$LocalDb, $LocalMembersTable, LocalMember>,
          ),
          LocalMember,
          PrefetchHooks Function()
        > {
  $$LocalMembersTableTableManager(_$LocalDb db, $LocalMembersTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$LocalMembersTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$LocalMembersTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$LocalMembersTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> empId = const Value.absent(),
                Value<String> name = const Value.absent(),
                Value<String> shift = const Value.absent(),
                Value<String> role = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => LocalMembersCompanion(
                empId: empId,
                name: name,
                shift: shift,
                role: role,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String empId,
                required String name,
                required String shift,
                required String role,
                Value<int> rowid = const Value.absent(),
              }) => LocalMembersCompanion.insert(
                empId: empId,
                name: name,
                shift: shift,
                role: role,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$LocalMembersTableProcessedTableManager =
    ProcessedTableManager<
      _$LocalDb,
      $LocalMembersTable,
      LocalMember,
      $$LocalMembersTableFilterComposer,
      $$LocalMembersTableOrderingComposer,
      $$LocalMembersTableAnnotationComposer,
      $$LocalMembersTableCreateCompanionBuilder,
      $$LocalMembersTableUpdateCompanionBuilder,
      (LocalMember, BaseReferences<_$LocalDb, $LocalMembersTable, LocalMember>),
      LocalMember,
      PrefetchHooks Function()
    >;
typedef $$LocalSessionTableCreateCompanionBuilder =
    LocalSessionCompanion Function({
      required String id,
      Value<String?> voucherNo,
      Value<String?> zone,
      required String warehouseCode,
      required DateTime openedAt,
      Value<DateTime?> dataAsOf,
      Value<bool> staleCache,
      Value<int> rowid,
    });
typedef $$LocalSessionTableUpdateCompanionBuilder =
    LocalSessionCompanion Function({
      Value<String> id,
      Value<String?> voucherNo,
      Value<String?> zone,
      Value<String> warehouseCode,
      Value<DateTime> openedAt,
      Value<DateTime?> dataAsOf,
      Value<bool> staleCache,
      Value<int> rowid,
    });

class $$LocalSessionTableFilterComposer
    extends Composer<_$LocalDb, $LocalSessionTable> {
  $$LocalSessionTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get voucherNo => $composableBuilder(
    column: $table.voucherNo,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get zone => $composableBuilder(
    column: $table.zone,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get warehouseCode => $composableBuilder(
    column: $table.warehouseCode,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get openedAt => $composableBuilder(
    column: $table.openedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get dataAsOf => $composableBuilder(
    column: $table.dataAsOf,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get staleCache => $composableBuilder(
    column: $table.staleCache,
    builder: (column) => ColumnFilters(column),
  );
}

class $$LocalSessionTableOrderingComposer
    extends Composer<_$LocalDb, $LocalSessionTable> {
  $$LocalSessionTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get voucherNo => $composableBuilder(
    column: $table.voucherNo,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get zone => $composableBuilder(
    column: $table.zone,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get warehouseCode => $composableBuilder(
    column: $table.warehouseCode,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get openedAt => $composableBuilder(
    column: $table.openedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get dataAsOf => $composableBuilder(
    column: $table.dataAsOf,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get staleCache => $composableBuilder(
    column: $table.staleCache,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$LocalSessionTableAnnotationComposer
    extends Composer<_$LocalDb, $LocalSessionTable> {
  $$LocalSessionTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get voucherNo =>
      $composableBuilder(column: $table.voucherNo, builder: (column) => column);

  GeneratedColumn<String> get zone =>
      $composableBuilder(column: $table.zone, builder: (column) => column);

  GeneratedColumn<String> get warehouseCode => $composableBuilder(
    column: $table.warehouseCode,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get openedAt =>
      $composableBuilder(column: $table.openedAt, builder: (column) => column);

  GeneratedColumn<DateTime> get dataAsOf =>
      $composableBuilder(column: $table.dataAsOf, builder: (column) => column);

  GeneratedColumn<bool> get staleCache => $composableBuilder(
    column: $table.staleCache,
    builder: (column) => column,
  );
}

class $$LocalSessionTableTableManager
    extends
        RootTableManager<
          _$LocalDb,
          $LocalSessionTable,
          LocalSessionData,
          $$LocalSessionTableFilterComposer,
          $$LocalSessionTableOrderingComposer,
          $$LocalSessionTableAnnotationComposer,
          $$LocalSessionTableCreateCompanionBuilder,
          $$LocalSessionTableUpdateCompanionBuilder,
          (
            LocalSessionData,
            BaseReferences<_$LocalDb, $LocalSessionTable, LocalSessionData>,
          ),
          LocalSessionData,
          PrefetchHooks Function()
        > {
  $$LocalSessionTableTableManager(_$LocalDb db, $LocalSessionTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$LocalSessionTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$LocalSessionTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$LocalSessionTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String?> voucherNo = const Value.absent(),
                Value<String?> zone = const Value.absent(),
                Value<String> warehouseCode = const Value.absent(),
                Value<DateTime> openedAt = const Value.absent(),
                Value<DateTime?> dataAsOf = const Value.absent(),
                Value<bool> staleCache = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => LocalSessionCompanion(
                id: id,
                voucherNo: voucherNo,
                zone: zone,
                warehouseCode: warehouseCode,
                openedAt: openedAt,
                dataAsOf: dataAsOf,
                staleCache: staleCache,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                Value<String?> voucherNo = const Value.absent(),
                Value<String?> zone = const Value.absent(),
                required String warehouseCode,
                required DateTime openedAt,
                Value<DateTime?> dataAsOf = const Value.absent(),
                Value<bool> staleCache = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => LocalSessionCompanion.insert(
                id: id,
                voucherNo: voucherNo,
                zone: zone,
                warehouseCode: warehouseCode,
                openedAt: openedAt,
                dataAsOf: dataAsOf,
                staleCache: staleCache,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$LocalSessionTableProcessedTableManager =
    ProcessedTableManager<
      _$LocalDb,
      $LocalSessionTable,
      LocalSessionData,
      $$LocalSessionTableFilterComposer,
      $$LocalSessionTableOrderingComposer,
      $$LocalSessionTableAnnotationComposer,
      $$LocalSessionTableCreateCompanionBuilder,
      $$LocalSessionTableUpdateCompanionBuilder,
      (
        LocalSessionData,
        BaseReferences<_$LocalDb, $LocalSessionTable, LocalSessionData>,
      ),
      LocalSessionData,
      PrefetchHooks Function()
    >;
typedef $$LocalSessionRowsTableCreateCompanionBuilder =
    LocalSessionRowsCompanion Function({
      required String sessionId,
      required String sku,
      required String name,
      required double systemQty,
      Value<String?> unit,
      Value<String?> loc,
      Value<String?> zone,
      Value<int> rowid,
    });
typedef $$LocalSessionRowsTableUpdateCompanionBuilder =
    LocalSessionRowsCompanion Function({
      Value<String> sessionId,
      Value<String> sku,
      Value<String> name,
      Value<double> systemQty,
      Value<String?> unit,
      Value<String?> loc,
      Value<String?> zone,
      Value<int> rowid,
    });

class $$LocalSessionRowsTableFilterComposer
    extends Composer<_$LocalDb, $LocalSessionRowsTable> {
  $$LocalSessionRowsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sku => $composableBuilder(
    column: $table.sku,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get systemQty => $composableBuilder(
    column: $table.systemQty,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get unit => $composableBuilder(
    column: $table.unit,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get loc => $composableBuilder(
    column: $table.loc,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get zone => $composableBuilder(
    column: $table.zone,
    builder: (column) => ColumnFilters(column),
  );
}

class $$LocalSessionRowsTableOrderingComposer
    extends Composer<_$LocalDb, $LocalSessionRowsTable> {
  $$LocalSessionRowsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sku => $composableBuilder(
    column: $table.sku,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get systemQty => $composableBuilder(
    column: $table.systemQty,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get unit => $composableBuilder(
    column: $table.unit,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get loc => $composableBuilder(
    column: $table.loc,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get zone => $composableBuilder(
    column: $table.zone,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$LocalSessionRowsTableAnnotationComposer
    extends Composer<_$LocalDb, $LocalSessionRowsTable> {
  $$LocalSessionRowsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get sku =>
      $composableBuilder(column: $table.sku, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<double> get systemQty =>
      $composableBuilder(column: $table.systemQty, builder: (column) => column);

  GeneratedColumn<String> get unit =>
      $composableBuilder(column: $table.unit, builder: (column) => column);

  GeneratedColumn<String> get loc =>
      $composableBuilder(column: $table.loc, builder: (column) => column);

  GeneratedColumn<String> get zone =>
      $composableBuilder(column: $table.zone, builder: (column) => column);
}

class $$LocalSessionRowsTableTableManager
    extends
        RootTableManager<
          _$LocalDb,
          $LocalSessionRowsTable,
          LocalSessionRow,
          $$LocalSessionRowsTableFilterComposer,
          $$LocalSessionRowsTableOrderingComposer,
          $$LocalSessionRowsTableAnnotationComposer,
          $$LocalSessionRowsTableCreateCompanionBuilder,
          $$LocalSessionRowsTableUpdateCompanionBuilder,
          (
            LocalSessionRow,
            BaseReferences<_$LocalDb, $LocalSessionRowsTable, LocalSessionRow>,
          ),
          LocalSessionRow,
          PrefetchHooks Function()
        > {
  $$LocalSessionRowsTableTableManager(
    _$LocalDb db,
    $LocalSessionRowsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$LocalSessionRowsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$LocalSessionRowsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$LocalSessionRowsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> sessionId = const Value.absent(),
                Value<String> sku = const Value.absent(),
                Value<String> name = const Value.absent(),
                Value<double> systemQty = const Value.absent(),
                Value<String?> unit = const Value.absent(),
                Value<String?> loc = const Value.absent(),
                Value<String?> zone = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => LocalSessionRowsCompanion(
                sessionId: sessionId,
                sku: sku,
                name: name,
                systemQty: systemQty,
                unit: unit,
                loc: loc,
                zone: zone,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String sessionId,
                required String sku,
                required String name,
                required double systemQty,
                Value<String?> unit = const Value.absent(),
                Value<String?> loc = const Value.absent(),
                Value<String?> zone = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => LocalSessionRowsCompanion.insert(
                sessionId: sessionId,
                sku: sku,
                name: name,
                systemQty: systemQty,
                unit: unit,
                loc: loc,
                zone: zone,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$LocalSessionRowsTableProcessedTableManager =
    ProcessedTableManager<
      _$LocalDb,
      $LocalSessionRowsTable,
      LocalSessionRow,
      $$LocalSessionRowsTableFilterComposer,
      $$LocalSessionRowsTableOrderingComposer,
      $$LocalSessionRowsTableAnnotationComposer,
      $$LocalSessionRowsTableCreateCompanionBuilder,
      $$LocalSessionRowsTableUpdateCompanionBuilder,
      (
        LocalSessionRow,
        BaseReferences<_$LocalDb, $LocalSessionRowsTable, LocalSessionRow>,
      ),
      LocalSessionRow,
      PrefetchHooks Function()
    >;
typedef $$OutboxTableCreateCompanionBuilder =
    OutboxCompanion Function({
      required String id,
      required String type,
      Value<String?> sessionId,
      Value<String?> sku,
      required String payloadJson,
      required int deviceSeq,
      required DateTime createdAt,
      Value<String> status,
      Value<int> attempts,
      Value<DateTime?> nextRetryAt,
      Value<String?> lastError,
      Value<String?> rejectCode,
      Value<int> rowid,
    });
typedef $$OutboxTableUpdateCompanionBuilder =
    OutboxCompanion Function({
      Value<String> id,
      Value<String> type,
      Value<String?> sessionId,
      Value<String?> sku,
      Value<String> payloadJson,
      Value<int> deviceSeq,
      Value<DateTime> createdAt,
      Value<String> status,
      Value<int> attempts,
      Value<DateTime?> nextRetryAt,
      Value<String?> lastError,
      Value<String?> rejectCode,
      Value<int> rowid,
    });

class $$OutboxTableFilterComposer extends Composer<_$LocalDb, $OutboxTable> {
  $$OutboxTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get type => $composableBuilder(
    column: $table.type,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sku => $composableBuilder(
    column: $table.sku,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get deviceSeq => $composableBuilder(
    column: $table.deviceSeq,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get attempts => $composableBuilder(
    column: $table.attempts,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get nextRetryAt => $composableBuilder(
    column: $table.nextRetryAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get rejectCode => $composableBuilder(
    column: $table.rejectCode,
    builder: (column) => ColumnFilters(column),
  );
}

class $$OutboxTableOrderingComposer extends Composer<_$LocalDb, $OutboxTable> {
  $$OutboxTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get type => $composableBuilder(
    column: $table.type,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sku => $composableBuilder(
    column: $table.sku,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get deviceSeq => $composableBuilder(
    column: $table.deviceSeq,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get attempts => $composableBuilder(
    column: $table.attempts,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get nextRetryAt => $composableBuilder(
    column: $table.nextRetryAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get rejectCode => $composableBuilder(
    column: $table.rejectCode,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$OutboxTableAnnotationComposer
    extends Composer<_$LocalDb, $OutboxTable> {
  $$OutboxTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get type =>
      $composableBuilder(column: $table.type, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get sku =>
      $composableBuilder(column: $table.sku, builder: (column) => column);

  GeneratedColumn<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => column,
  );

  GeneratedColumn<int> get deviceSeq =>
      $composableBuilder(column: $table.deviceSeq, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<int> get attempts =>
      $composableBuilder(column: $table.attempts, builder: (column) => column);

  GeneratedColumn<DateTime> get nextRetryAt => $composableBuilder(
    column: $table.nextRetryAt,
    builder: (column) => column,
  );

  GeneratedColumn<String> get lastError =>
      $composableBuilder(column: $table.lastError, builder: (column) => column);

  GeneratedColumn<String> get rejectCode => $composableBuilder(
    column: $table.rejectCode,
    builder: (column) => column,
  );
}

class $$OutboxTableTableManager
    extends
        RootTableManager<
          _$LocalDb,
          $OutboxTable,
          OutboxRow,
          $$OutboxTableFilterComposer,
          $$OutboxTableOrderingComposer,
          $$OutboxTableAnnotationComposer,
          $$OutboxTableCreateCompanionBuilder,
          $$OutboxTableUpdateCompanionBuilder,
          (OutboxRow, BaseReferences<_$LocalDb, $OutboxTable, OutboxRow>),
          OutboxRow,
          PrefetchHooks Function()
        > {
  $$OutboxTableTableManager(_$LocalDb db, $OutboxTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$OutboxTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$OutboxTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$OutboxTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> type = const Value.absent(),
                Value<String?> sessionId = const Value.absent(),
                Value<String?> sku = const Value.absent(),
                Value<String> payloadJson = const Value.absent(),
                Value<int> deviceSeq = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<int> attempts = const Value.absent(),
                Value<DateTime?> nextRetryAt = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                Value<String?> rejectCode = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => OutboxCompanion(
                id: id,
                type: type,
                sessionId: sessionId,
                sku: sku,
                payloadJson: payloadJson,
                deviceSeq: deviceSeq,
                createdAt: createdAt,
                status: status,
                attempts: attempts,
                nextRetryAt: nextRetryAt,
                lastError: lastError,
                rejectCode: rejectCode,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String type,
                Value<String?> sessionId = const Value.absent(),
                Value<String?> sku = const Value.absent(),
                required String payloadJson,
                required int deviceSeq,
                required DateTime createdAt,
                Value<String> status = const Value.absent(),
                Value<int> attempts = const Value.absent(),
                Value<DateTime?> nextRetryAt = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                Value<String?> rejectCode = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => OutboxCompanion.insert(
                id: id,
                type: type,
                sessionId: sessionId,
                sku: sku,
                payloadJson: payloadJson,
                deviceSeq: deviceSeq,
                createdAt: createdAt,
                status: status,
                attempts: attempts,
                nextRetryAt: nextRetryAt,
                lastError: lastError,
                rejectCode: rejectCode,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$OutboxTableProcessedTableManager =
    ProcessedTableManager<
      _$LocalDb,
      $OutboxTable,
      OutboxRow,
      $$OutboxTableFilterComposer,
      $$OutboxTableOrderingComposer,
      $$OutboxTableAnnotationComposer,
      $$OutboxTableCreateCompanionBuilder,
      $$OutboxTableUpdateCompanionBuilder,
      (OutboxRow, BaseReferences<_$LocalDb, $OutboxTable, OutboxRow>),
      OutboxRow,
      PrefetchHooks Function()
    >;
typedef $$KvMetaTableCreateCompanionBuilder =
    KvMetaCompanion Function({
      required String key,
      required String value,
      Value<int> rowid,
    });
typedef $$KvMetaTableUpdateCompanionBuilder =
    KvMetaCompanion Function({
      Value<String> key,
      Value<String> value,
      Value<int> rowid,
    });

class $$KvMetaTableFilterComposer extends Composer<_$LocalDb, $KvMetaTable> {
  $$KvMetaTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get key => $composableBuilder(
    column: $table.key,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get value => $composableBuilder(
    column: $table.value,
    builder: (column) => ColumnFilters(column),
  );
}

class $$KvMetaTableOrderingComposer extends Composer<_$LocalDb, $KvMetaTable> {
  $$KvMetaTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get key => $composableBuilder(
    column: $table.key,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get value => $composableBuilder(
    column: $table.value,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$KvMetaTableAnnotationComposer
    extends Composer<_$LocalDb, $KvMetaTable> {
  $$KvMetaTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get key =>
      $composableBuilder(column: $table.key, builder: (column) => column);

  GeneratedColumn<String> get value =>
      $composableBuilder(column: $table.value, builder: (column) => column);
}

class $$KvMetaTableTableManager
    extends
        RootTableManager<
          _$LocalDb,
          $KvMetaTable,
          KvMetaRow,
          $$KvMetaTableFilterComposer,
          $$KvMetaTableOrderingComposer,
          $$KvMetaTableAnnotationComposer,
          $$KvMetaTableCreateCompanionBuilder,
          $$KvMetaTableUpdateCompanionBuilder,
          (KvMetaRow, BaseReferences<_$LocalDb, $KvMetaTable, KvMetaRow>),
          KvMetaRow,
          PrefetchHooks Function()
        > {
  $$KvMetaTableTableManager(_$LocalDb db, $KvMetaTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$KvMetaTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$KvMetaTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$KvMetaTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> key = const Value.absent(),
                Value<String> value = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => KvMetaCompanion(key: key, value: value, rowid: rowid),
          createCompanionCallback:
              ({
                required String key,
                required String value,
                Value<int> rowid = const Value.absent(),
              }) =>
                  KvMetaCompanion.insert(key: key, value: value, rowid: rowid),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$KvMetaTableProcessedTableManager =
    ProcessedTableManager<
      _$LocalDb,
      $KvMetaTable,
      KvMetaRow,
      $$KvMetaTableFilterComposer,
      $$KvMetaTableOrderingComposer,
      $$KvMetaTableAnnotationComposer,
      $$KvMetaTableCreateCompanionBuilder,
      $$KvMetaTableUpdateCompanionBuilder,
      (KvMetaRow, BaseReferences<_$LocalDb, $KvMetaTable, KvMetaRow>),
      KvMetaRow,
      PrefetchHooks Function()
    >;

class $LocalDbManager {
  final _$LocalDb _db;
  $LocalDbManager(this._db);
  $$LocalItemsTableTableManager get localItems =>
      $$LocalItemsTableTableManager(_db, _db.localItems);
  $$LocalBarcodesTableTableManager get localBarcodes =>
      $$LocalBarcodesTableTableManager(_db, _db.localBarcodes);
  $$LocalMembersTableTableManager get localMembers =>
      $$LocalMembersTableTableManager(_db, _db.localMembers);
  $$LocalSessionTableTableManager get localSession =>
      $$LocalSessionTableTableManager(_db, _db.localSession);
  $$LocalSessionRowsTableTableManager get localSessionRows =>
      $$LocalSessionRowsTableTableManager(_db, _db.localSessionRows);
  $$OutboxTableTableManager get outbox =>
      $$OutboxTableTableManager(_db, _db.outbox);
  $$KvMetaTableTableManager get kvMeta =>
      $$KvMetaTableTableManager(_db, _db.kvMeta);
}
